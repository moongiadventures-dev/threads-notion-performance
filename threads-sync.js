import { Client } from '@notionhq/client';
import * as cron from 'node-cron';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createPublicKey, publicEncrypt, constants } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE   = path.join(__dirname, 'sync.log');
const TOKEN_FILE = path.join(__dirname, '.token');

const NOTION_DB_ID      = process.env.NOTION_DB_ID;
const APP_SECRET        = process.env.THREADS_APP_SECRET;
const GH_TOKEN          = process.env.GH_TOKEN;
const GH_REPO           = process.env.GH_REPO;
const POSTS_LIMIT       = parseInt(process.env.POSTS_LIMIT || '50');
const CRON_SCHEDULE     = process.env.CRON_SCHEDULE || '0 9 * * 1';
const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── GITHUB SECRETS UPDATE ─────────────────────────────────────
async function updateGitHubSecret(secretName, secretValue) {
  if (!GH_TOKEN || !GH_REPO) {
    log('GH_TOKEN or GH_REPO not set — skipping GitHub Secrets update', 'WARN');
    return false;
  }
  try {
    const [owner, repo] = GH_REPO.split('/');
    const keyRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    const { key, key_id } = await keyRes.json();
    const pubKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    const encrypted = publicEncrypt(
      { key: pubKey, padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(secretValue)
    ).toString('base64');
    const updateRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_value: encrypted, key_id })
      }
    );
    if (updateRes.status === 201 || updateRes.status === 204) {
      log(`✓ GitHub Secret "${secretName}" updated with long-lived token`);
      return true;
    }
    log(`GitHub Secret update failed: ${updateRes.status}`, 'WARN');
    return false;
  } catch (e) {
    log(`GitHub Secret update error: ${e.message}`, 'WARN');
    return false;
  }
}

// ── TOKEN MANAGEMENT ──────────────────────────────────────────
function loadToken() {
  if (IS_GITHUB_ACTIONS) return { token: process.env.THREADS_TOKEN, expires_at: null };
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return { token: process.env.THREADS_TOKEN, expires_at: null };
  }
}

async function saveToken(token, expiresIn) {
  const expires_at = Date.now() + (expiresIn * 1000);
  if (!IS_GITHUB_ACTIONS) {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expires_at }));
  }
  await updateGitHubSecret('THREADS_TOKEN', token);
  log(`Token saved. Expires: ${new Date(expires_at).toDateString()} (${Math.round(expiresIn / 86400)} days)`);
  return expires_at;
}

async function getValidToken() {
  const { token, expires_at } = loadToken();
  if (!token) throw new Error('No Threads token found. Set THREADS_TOKEN in .env or GitHub Secrets');

  const sevenDays    = 7 * 24 * 60 * 60 * 1000;
  const isShortLived = !expires_at;
  const isExpiring   = expires_at && (expires_at - Date.now()) < sevenDays;

  // Refresh long-lived token expiring soon
  if (isExpiring && !isShortLived) {
    log('Token expiring soon — refreshing...');
    try {
      const res  = await fetch(`https://graph.threads.net/access_token?grant_type=th_refresh_token&access_token=${token}`);
      const data = await res.json();
      if (data.access_token) { await saveToken(data.access_token, data.expires_in); return data.access_token; }
    } catch (e) { log(`Refresh failed: ${e.message}`, 'WARN'); }
  }

  // Exchange short-lived for long-lived
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
async function fetchPosts(token) {
  const fields = 'id,text,timestamp,media_type,media_url,thumbnail_url,permalink,like_count,replies_count,reposts_count,quotes_count,views';
  const res    = await fetch(`https://graph.threads.net/v1.0/me/threads?fields=${fields}&limit=${POSTS_LIMIT}&access_token=${token}`);
  const data   = await res.json();
  if (data.error) throw new Error(`Threads API: ${data.error.message}`);
  return data.data || [];
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

function buildBlocks(post, mediaType) {
  const blocks = [];
  if (post.text) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: post.text } }] } });
  blocks.push({ object: 'block', type: 'divider', divider: {} });
  if ((mediaType === 'Image' || mediaType === 'Carousel') && post.media_url) {
    blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: post.media_url } } });
  }
  if (mediaType === 'Video') {
    if (post.thumbnail_url) blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: post.thumbnail_url } } });
    if (post.media_url) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '▶ Watch video', link: { url: post.media_url } }, annotations: { bold: true, color: 'blue' } }] } });
  }
  if (post.permalink) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '→ View on Threads', link: { url: post.permalink } }, annotations: { color: 'gray' } }] } });
  return blocks;
}

async function syncPost(post, insights) {
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
  if (post.media_url) props['Media URL'] = { url: post.media_url };
  if (post.permalink) props['Post URL']  = { url: post.permalink };

  const existing = await findExistingPage(post.id);
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: { 'Views': { number: views }, 'Likes': { number: likes }, 'Replies': { number: replies }, 'Reposts': { number: reposts }, 'Quotes': { number: quotes }, 'Performance': { select: { name: performance } }, 'Last Synced': { date: { start: today } } } });
    return { action: 'updated', engRate, mediaType };
  } else {
    await notion.pages.create({ parent: { database_id: NOTION_DB_ID }, properties: props, children: buildBlocks(post, mediaType) });
    return { action: 'created', engRate, mediaType };
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function runSync() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`THREADS → NOTION SYNC STARTED [${IS_GITHUB_ACTIONS ? 'GitHub Actions' : 'Local'}]`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const token = await getValidToken();
  const posts = await fetchPosts(token);
  log(`Found ${posts.length} posts`);

  let created=0, updated=0, failed=0, totalViews=0, totalLikes=0;

  for (let i=0; i<posts.length; i++) {
    const post    = posts[i];
    const preview = (post.text||'').substring(0, 50);
    log(`[${i+1}/${posts.length}] ${getMediaType(post)} — "${preview}..."`);
    try {
      const insights = await fetchInsights(post.id, token);
      const result   = await syncPost(post, insights);
      totalViews += (insights?.views || post.views || 0);
      totalLikes += (insights?.likes || post.like_count || 0);
      if (result.action === 'created') created++; else updated++;
      log(`  ✓ ${result.action.toUpperCase()} — ${result.engRate}% ER · ${result.mediaType}`);
    } catch(e) {
      failed++;
      log(`  ✗ FAILED: ${e.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 500));
  }

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`DONE: ${created} created · ${updated} updated · ${failed} failed`);
  log(`TOTALS: ${totalViews.toLocaleString()} views · ${totalLikes.toLocaleString()} likes`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

const args = process.argv.slice(2);
if (args.includes('--run-now')) {
  runSync().catch(e => { log(`FATAL: ${e.message}`, 'ERROR'); process.exit(1); });
} else {
  log(`Scheduler started. Cron: "${CRON_SCHEDULE}"`);
  cron.schedule(CRON_SCHEDULE, () => runSync().catch(e => log(`FATAL: ${e.message}`, 'ERROR')));
  runSync().catch(e => log(`FATAL: ${e.message}`, 'ERROR'));
}
