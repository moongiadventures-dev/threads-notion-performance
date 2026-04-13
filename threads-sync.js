import { Client } from '@notionhq/client';
import * as cron from 'node-cron';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE   = path.join(__dirname, 'sync.log');
const TOKEN_FILE = path.join(__dirname, '.token');

const NOTION_DB_ID      = process.env.NOTION_DB_ID;
const APP_SECRET        = process.env.THREADS_APP_SECRET;
const GH_TOKEN          = process.env.GH_TOKEN;
const GH_REPO           = process.env.GH_REPO;
const DRIVE_FOLDER_ID   = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CRON_SCHEDULE     = process.env.CRON_SCHEDULE || '0 9 * * 1';
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const TWO_WEEKS_MS      = 14 * 24 * 60 * 60 * 1000;

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── GOOGLE DRIVE SETUP ────────────────────────────────────────
function getDriveClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
  } catch (e) {
    log(`Google Drive auth error: ${e.message}`, 'WARN');
    return null;
  }
}

async function uploadToDrive(drive, url, filename, mimeType) {
  if (!drive || !DRIVE_FOLDER_ID || !url) return null;
  try {
    // Download the file
    const res = await fetch(url);
    if (!res.ok) return null;

    const buffer = await res.buffer();
    const readableStream = stream.Readable.from(buffer);

    // Upload to Google Drive
    const uploaded = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [DRIVE_FOLDER_ID]
      },
      media: {
        mimeType,
        body: readableStream
      },
      fields: 'id, webViewLink, webContentLink'
    });

    // Make it publicly viewable
    await drive.permissions.create({
      fileId: uploaded.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    // Return direct view link
    const fileId = uploaded.data.id;
    const directLink = `https://drive.google.com/uc?export=view&id=${fileId}`;
    log(`  ☁ Uploaded to Drive: ${filename}`);
    return directLink;
  } catch (e) {
    log(`  Drive upload failed for ${filename}: ${e.message}`, 'WARN');
    return null; // Fall back to original URL
  }
}

function getFilenameAndMime(url, postId, mediaType) {
  const ext = mediaType === 'Video' ? 'mp4' : 'jpg';
  const mime = mediaType === 'Video' ? 'video/mp4' : 'image/jpeg';
  return { filename: `threads_${postId}.${ext}`, mime };
}

// ── GITHUB SECRETS UPDATE ─────────────────────────────────────
async function updateGitHubSecret(secretName, secretValue) {
  if (!GH_TOKEN || !GH_REPO) return false;
  try {
    const [owner, repo] = GH_REPO.split('/');
    const keyRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    const { key, key_id } = await keyRes.json();
    const { default: sodium } = await import('libsodium-wrappers');
    await sodium.ready;
    const messageBytes = Buffer.from(secretValue);
    const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encrypted_value = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
    const updateRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value, key_id })
      }
    );
    if (updateRes.status === 201 || updateRes.status === 204) {
      log(`✓ GitHub Secret "${secretName}" updated`);
      return true;
    }
    return false;
  } catch (e) {
    log(`GitHub Secret update error: ${e.message}`, 'WARN');
    return false;
  }
}

// ── TOKEN MANAGEMENT ──────────────────────────────────────────
function loadToken() {
  if (IS_GITHUB_ACTIONS) return { token: process.env.THREADS_TOKEN, expires_at: null };
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return { token: process.env.THREADS_TOKEN, expires_at: null }; }
}

async function saveToken(token, expiresIn) {
  const expires_at = Date.now() + (expiresIn * 1000);
  if (!IS_GITHUB_ACTIONS) fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expires_at }));
  await updateGitHubSecret('THREADS_TOKEN', token);
  log(`Token saved. Expires: ${new Date(expires_at).toDateString()} (${Math.round(expiresIn / 86400)} days)`);
  return expires_at;
}

async function getValidToken() {
  const { token, expires_at } = loadToken();
  if (!token) throw new Error('No Threads token found');
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  const isShortLived = !expires_at;
  const isExpiring   = expires_at && (expires_at - Date.now()) < fourteenDays;

  if (isExpiring && !isShortLived) {
    try {
      const res  = await fetch(`https://graph.threads.net/access_token?grant_type=th_refresh_token&access_token=${token}`);
      const data = await res.json();
      if (data.access_token) { await saveToken(data.access_token, data.expires_in); return data.access_token; }
    } catch (e) { log(`Refresh failed: ${e.message}`, 'WARN'); }
  }

  if ((isShortLived || isExpiring) && APP_SECRET) {
    log('Exchanging for 60-day long-lived token...');
    try {
      const res  = await fetch(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${APP_SECRET}&access_token=${token}`);
      const data = await res.json();
      if (data.access_token) { await saveToken(data.access_token, data.expires_in); return data.access_token; }
      else log(`Exchange failed: ${JSON.stringify(data)}`, 'WARN');
    } catch (e) { log(`Exchange error: ${e.message}`, 'WARN'); }
  }

  return token;
}

// ── THREADS API ───────────────────────────────────────────────
async function fetchAllPosts(token, fullSync = false) {
  const fields = 'id,text,timestamp,media_type,media_url,thumbnail_url,permalink,like_count,replies_count,reposts_count,quotes_count,views';
  const pageSize = 100;
  const since = fullSync ? null : new Date(Date.now() - TWO_WEEKS_MS);
  let allPosts = [], cursor = null, page = 1;

  log(fullSync ? 'FULL SYNC — fetching ALL posts...' : 'WEEKLY MODE — last 2 weeks...');

  while (true) {
    let url = `https://graph.threads.net/v1.0/me/threads?fields=${fields}&limit=${pageSize}&access_token=${token}`;
    if (cursor) url += `&after=${cursor}`;

    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Threads API: ${data.error.message}`);

    const posts = data.data || [];

    if (!fullSync) {
      const recentPosts = posts.filter(p => new Date(p.timestamp) >= since);
      allPosts = allPosts.concat(recentPosts);
      log(`  Page ${page}: ${recentPosts.length} posts in last 2 weeks (total: ${allPosts.length})`);
      if (recentPosts.length < posts.length) { log('Reached posts older than 2 weeks — stopping'); break; }
    } else {
      allPosts = allPosts.concat(posts);
      log(`  Page ${page}: ${posts.length} posts (total: ${allPosts.length})`);
    }

    const nextCursor = data.paging?.cursors?.after;
    if (!nextCursor || posts.length < pageSize) { log('All posts fetched'); break; }
    cursor = nextCursor;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  return allPosts;
}

async function fetchInsights(postId, token) {
  try {
    const res  = await fetch(`https://graph.threads.net/v1.0/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${token}`);
    const data = await res.json();
    if (data.error || !data.data) return null;
    const m = {};
    data.data.forEach(x => { m[x.name] = x.values?.[0]?.value || 0; });
    return m;
  } catch { return null; }
}

// ── HELPERS ───────────────────────────────────────────────────
function getMediaType(post) {
  const t = post.media_type;
  if (!t || t === 'TEXT') return 'Text';
  if (t === 'IMAGE') return 'Image';
  if (t === 'VIDEO') return 'Video';
  if (t === 'CAROUSEL_ALBUM') return 'Carousel';
  return 'Text';
}

function getPerformance(r) {
  if (r >= 5)   return '🔥 Top';
  if (r >= 2)   return '👍 Good';
  if (r >= 0.5) return '📊 Average';
  return '📉 Low';
}

// ── NOTION ────────────────────────────────────────────────────
async function findExistingPage(postId) {
  try {
    const res = await notion.databases.query({
      database_id: NOTION_DB_ID,
      filter: { property: 'Post ID', rich_text: { equals: postId } }
    });
    return res.results[0] || null;
  } catch { return null; }
}

function buildBlocks(post, mediaType, driveImageUrl, driveVideoUrl) {
  const blocks = [];

  if (post.text) {
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: post.text } }] } });
  }
  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Use Drive URL if available, otherwise fall back to original (may expire)
  const imageUrl = driveImageUrl || post.media_url;
  const videoThumb = driveVideoUrl || post.thumbnail_url;

  if ((mediaType === 'Image' || mediaType === 'Carousel') && imageUrl) {
    blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: imageUrl } } });
  }

  if (mediaType === 'Video') {
    if (videoThumb) {
      blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: videoThumb } } });
    }
    const videoLink = driveVideoUrl || post.media_url;
    if (videoLink) {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: '▶ Watch video', link: { url: videoLink } }, annotations: { bold: true, color: 'blue' } }] }
      });
    }
  }

  if (post.permalink) {
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: '→ View on Threads', link: { url: post.permalink } }, annotations: { color: 'gray' } }] }
    });
  }

  // Add Drive folder link if media was uploaded
  if (driveImageUrl || driveVideoUrl) {
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: '☁ Saved to Google Drive (permanent)', link: { url: `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}` } }, annotations: { color: 'gray', italic: true } }] }
    });
  }

  return blocks;
}

async function syncPost(post, insights, drive) {
  const mediaType   = getMediaType(post);
  const views       = insights?.views   || post.views          || 0;
  const likes       = insights?.likes   || post.like_count     || 0;
  const replies     = insights?.replies || post.replies_count  || 0;
  const reposts     = insights?.reposts || post.reposts_count  || 0;
  const quotes      = insights?.quotes  || post.quotes_count   || 0;
  const engRate     = views > 0 ? Math.round(((likes+replies+reposts+quotes)/views)*10000)/100 : 0;
  const performance = getPerformance(engRate);
  const datePosted  = post.timestamp ? post.timestamp.split('T')[0] : new Date().toISOString().split('T')[0];
  const today       = new Date().toISOString().split('T')[0];
  const preview     = (post.text || '(no text)').substring(0, 80);

  // Upload media to Google Drive for permanent storage
  let driveImageUrl = null;
  let driveVideoUrl = null;

  if (drive) {
    if ((mediaType === 'Image' || mediaType === 'Carousel') && post.media_url) {
      const { filename, mime } = getFilenameAndMime(post.media_url, post.id, 'Image');
      driveImageUrl = await uploadToDrive(drive, post.media_url, filename, mime);
    }
    if (mediaType === 'Video') {
      if (post.thumbnail_url) {
        const { filename, mime } = getFilenameAndMime(post.thumbnail_url, `${post.id}_thumb`, 'Image');
        driveVideoUrl = await uploadToDrive(drive, post.thumbnail_url, filename, mime);
      }
      if (post.media_url) {
        const { filename, mime } = getFilenameAndMime(post.media_url, post.id, 'Video');
        const videoUrl = await uploadToDrive(drive, post.media_url, filename, mime);
        if (videoUrl) driveVideoUrl = videoUrl;
      }
    }
  }

  // Use Drive URL in DB if available, otherwise fall back to Threads URL
  const finalMediaUrl = driveImageUrl || driveVideoUrl || post.media_url || null;

  const props = {
    'Post':        { title: [{ text: { content: preview } }] },
    'Post ID':     { rich_text: [{ text: { content: post.id } }] },
    'Media Type':  { select: { name: mediaType } },
    'Views':       { number: views },
    'Likes':       { number: likes },
    'Replies':     { number: replies },
    'Reposts':     { number: reposts },
    'Quotes':      { number: quotes },
    'Performance': { select: { name: performance } },
    'Date Posted': { date: { start: datePosted } },
    'Last Synced': { date: { start: today } },
  };

  if (finalMediaUrl) props['Media URL'] = { url: finalMediaUrl };
  if (post.permalink) props['Post URL']  = { url: post.permalink };

  const existing = await findExistingPage(post.id);

  if (existing) {
    // Update metrics + media URL if Drive upload succeeded
    const updateProps = {
      'Views': { number: views }, 'Likes': { number: likes },
      'Replies': { number: replies }, 'Reposts': { number: reposts },
      'Quotes': { number: quotes }, 'Performance': { select: { name: performance } },
      'Last Synced': { date: { start: today } }
    };
    if (finalMediaUrl) updateProps['Media URL'] = { url: finalMediaUrl };
    await notion.pages.update({ page_id: existing.id, properties: updateProps });
    return { action: 'updated', engRate, mediaType, hasDrive: !!(driveImageUrl || driveVideoUrl) };
  } else {
    await notion.pages.create({
      parent: { database_id: NOTION_DB_ID },
      properties: props,
      children: buildBlocks(post, mediaType, driveImageUrl, driveVideoUrl)
    });
    return { action: 'created', engRate, mediaType, hasDrive: !!(driveImageUrl || driveVideoUrl) };
  }
}

// ── MAIN SYNC ─────────────────────────────────────────────────
async function runSync(fullSync = false) {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`THREADS → NOTION SYNC [${IS_GITHUB_ACTIONS ? 'GitHub Actions' : 'Local'}] [${fullSync ? 'FULL' : 'LAST 2 WEEKS'}]`);

  const drive = getDriveClient();
  log(drive ? '☁ Google Drive: connected — files will be permanently saved' : '⚠ Google Drive: not configured — using Threads CDN URLs (may expire)');

  const token = await getValidToken();
  const posts = await fetchAllPosts(token, fullSync);
  log(`Total posts to sync: ${posts.length}`);

  let created=0, updated=0, failed=0, driveUploads=0, totalViews=0, totalLikes=0;

  for (let i=0; i<posts.length; i++) {
    const post    = posts[i];
    const preview = (post.text||'').substring(0, 50);
    log(`[${i+1}/${posts.length}] ${getMediaType(post)} — "${preview}..."`);
    try {
      const insights = await fetchInsights(post.id, token);
      const result   = await syncPost(post, insights, drive);
      totalViews += (insights?.views || post.views || 0);
      totalLikes += (insights?.likes || post.like_count || 0);
      if (result.action === 'created') created++; else updated++;
      if (result.hasDrive) driveUploads++;
      log(`  ✓ ${result.action.toUpperCase()} — ${result.engRate}% ER · ${result.mediaType}${result.hasDrive ? ' · ☁' : ''}`);
    } catch(e) {
      failed++;
      log(`  ✗ FAILED: ${e.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 600));
  }

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`DONE: ${created} created · ${updated} updated · ${failed} failed`);
  log(`DRIVE: ${driveUploads} files permanently saved to Google Drive`);
  log(`TOTALS: ${totalViews.toLocaleString()} views · ${totalLikes.toLocaleString()} likes`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ── ENTRY POINT ───────────────────────────────────────────────
const args = process.argv.slice(2);
const isFullSync = args.includes('--full-sync');
const isRunNow   = args.includes('--run-now') || isFullSync;

if (isRunNow) {
  runSync(isFullSync).catch(e => { log(`FATAL: ${e.message}`, 'ERROR'); process.exit(1); });
} else {
  log(`Scheduler started. Cron: "${CRON_SCHEDULE}"`);
  cron.schedule(CRON_SCHEDULE, () => runSync(false).catch(e => log(`FATAL: ${e.message}`, 'ERROR')));
  runSync(false).catch(e => log(`FATAL: ${e.message}`, 'ERROR'));
}
