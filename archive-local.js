import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';
dotenv.config();

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE   = path.join(__dirname, '.token');
const ARCHIVE_DIR  = path.join(__dirname, 'archive');
const LOG_FILE     = path.join(__dirname, 'archive.log');
const POSTS_LIMIT  = parseInt(process.env.POSTS_LIMIT || '50');
const FORCE        = process.argv.includes('--force');

function parseFlag(name) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}
const SINCE = parseFlag('since');  // YYYY-MM-DD (inclusive)
const UNTIL = parseFlag('until');  // YYYY-MM-DD (inclusive)

// ── LOGGING ───────────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── TOKEN ─────────────────────────────────────────────────────
function loadToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (t.token) return t.token;
  } catch {}
  return process.env.THREADS_TOKEN || null;
}

// ── THREADS API ───────────────────────────────────────────────
async function fetchPosts(token, sinceDate, untilDate) {
  const fields = 'id,text,timestamp,media_type,media_url,thumbnail_url,permalink,like_count,replies_count,reposts_count,quotes_count,views';
  const params = new URLSearchParams({ fields, limit: '100', access_token: token });
  if (sinceDate) params.set('since', String(Math.floor(new Date(sinceDate + 'T00:00:00Z').getTime() / 1000)));
  if (untilDate) params.set('until', String(Math.floor(new Date(untilDate + 'T23:59:59Z').getTime() / 1000)));

  let url = `https://graph.threads.net/v1.0/me/threads?${params}`;
  const all = [];
  let page = 0;
  while (url) {
    page++;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Threads API: ${data.error.message}`);
    const batch = data.data || [];
    all.push(...batch);
    log(`  fetched page ${page} (${batch.length} posts, running total: ${all.length})`);
    url = data.paging?.next || null;
    if (url) await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

async function fetchCarouselChildren(postId, token) {
  const fields = 'id,media_type,media_url,thumbnail_url';
  try {
    const res  = await fetch(`https://graph.threads.net/v1.0/${postId}/children?fields=${fields}&access_token=${token}`);
    const data = await res.json();
    if (data.error || !data.data) return [];
    return data.data;
  } catch { return []; }
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
const ILLEGAL_CHARS = /[\\\/:*?"<>|\x00-\x1f]/g;

function slugify(text) {
  if (!text) return 'untitled';
  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) return 'untitled';
  const words = cleaned.split(/\s+/).slice(0, 2);
  const slug  = words.join('-').replace(ILLEGAL_CHARS, '').replace(/[.\s-]+$/, '');
  return (slug || 'untitled').slice(0, 40);
}

function extFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return m[1].toLowerCase();
  } catch {}
  return fallback;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(res.body, fs.createWriteStream(destPath));
  const { size } = fs.statSync(destPath);
  return size;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ── ARCHIVE ONE POST ──────────────────────────────────────────
async function archivePost(post, token) {
  const datePosted = post.timestamp ? post.timestamp.split('T')[0] : 'unknown-date';
  const yearMonth  = datePosted.substring(0, 7);
  const slug       = slugify(post.text);
  // Disambiguate posts with no text (reposts, image-only) by appending a short post-id suffix
  const idSuffix   = (slug === 'untitled') ? `-${String(post.id).slice(-8)}` : '';
  const folderName = `${datePosted}_${slug}${idSuffix}`;
  const postDir    = path.join(ARCHIVE_DIR, yearMonth, folderName);

  if (fs.existsSync(postDir) && !FORCE) {
    return { status: 'skipped' };
  }

  fs.mkdirSync(postDir, { recursive: true });
  const insights = await fetchInsights(post.id, token);

  // Collect media items (carousel → children, otherwise single)
  let mediaItems = [];
  if (post.media_type === 'CAROUSEL_ALBUM') {
    const children = await fetchCarouselChildren(post.id, token);
    mediaItems = children.map(c => ({
      media_type:    c.media_type,
      media_url:     c.media_url,
      thumbnail_url: c.thumbnail_url,
    }));
  } else if (post.media_type && post.media_type !== 'TEXT') {
    mediaItems.push({
      media_type:    post.media_type,
      media_url:     post.media_url,
      thumbnail_url: post.thumbnail_url,
    });
  }

  const mediaRecords = [];
  let totalBytes = 0;
  let imgIdx = 0, vidIdx = 0;

  for (const item of mediaItems) {
    if (item.media_type === 'IMAGE' && item.media_url) {
      imgIdx++;
      const ext  = extFromUrl(item.media_url, 'jpg');
      const file = `image-${imgIdx}.${ext}`;
      try {
        const size = await downloadFile(item.media_url, path.join(postDir, file));
        totalBytes += size;
        mediaRecords.push({ type: 'image', file, bytes: size, source_url: item.media_url });
      } catch (e) {
        log(`  ! image ${imgIdx} download failed: ${e.message}`, 'WARN');
        mediaRecords.push({ type: 'image', file: null, source_url: item.media_url, error: e.message });
      }
    } else if (item.media_type === 'VIDEO' && item.media_url) {
      vidIdx++;
      const ext  = extFromUrl(item.media_url, 'mp4');
      const file = `video-${vidIdx}.${ext}`;
      const record = { type: 'video', file: null, source_url: item.media_url };
      try {
        const size = await downloadFile(item.media_url, path.join(postDir, file));
        totalBytes += size;
        record.file  = file;
        record.bytes = size;
      } catch (e) {
        log(`  ! video ${vidIdx} download failed: ${e.message}`, 'WARN');
        record.error = e.message;
      }
      // Thumbnail
      if (item.thumbnail_url) {
        const thumbExt  = extFromUrl(item.thumbnail_url, 'jpg');
        const thumbFile = `video-${vidIdx}-thumb.${thumbExt}`;
        try {
          const size = await downloadFile(item.thumbnail_url, path.join(postDir, thumbFile));
          totalBytes += size;
          record.thumbnail_file = thumbFile;
        } catch (e) {
          log(`  ! video ${vidIdx} thumbnail failed: ${e.message}`, 'WARN');
        }
      }
      mediaRecords.push(record);
    }
  }

  const metadata = {
    id:           post.id,
    text:         post.text || '',
    timestamp:    post.timestamp,
    media_type:   post.media_type || 'TEXT',
    permalink:    post.permalink,
    metrics: {
      views:   insights?.views   ?? post.views          ?? 0,
      likes:   insights?.likes   ?? post.like_count     ?? 0,
      replies: insights?.replies ?? post.replies_count  ?? 0,
      reposts: insights?.reposts ?? post.reposts_count  ?? 0,
      quotes:  insights?.quotes  ?? post.quotes_count   ?? 0,
    },
    media:        mediaRecords,
    archived_at:  new Date().toISOString(),
  };

  fs.writeFileSync(path.join(postDir, 'post.json'), JSON.stringify(metadata, null, 2));
  if (post.text) fs.writeFileSync(path.join(postDir, 'post.txt'), post.text);

  return { status: 'archived', bytes: totalBytes, mediaCount: mediaRecords.length };
}

// ── MAIN ──────────────────────────────────────────────────────
async function runArchive() {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`THREADS LOCAL ARCHIVE STARTED${FORCE ? ' [FORCE]' : ''}${SINCE || UNTIL ? ` [${SINCE || '*'}..${UNTIL || '*'}]` : ''}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const token = loadToken();
  if (!token) throw new Error('No Threads token. Run `npm run sync` first, or set THREADS_TOKEN in .env.');

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  log(`Fetching posts${SINCE || UNTIL ? ` (since=${SINCE || 'beginning'}, until=${UNTIL || 'now'})` : ''}...`);
  const posts = await fetchPosts(token, SINCE, UNTIL);
  log(`Found ${posts.length} posts from Threads API`);

  let archived = 0, skipped = 0, failed = 0, totalBytes = 0;

  for (let i = 0; i < posts.length; i++) {
    const post    = posts[i];
    const preview = (post.text || '(no text)').replace(/\s+/g, ' ').substring(0, 60);
    log(`[${i+1}/${posts.length}] ${post.media_type || 'TEXT'} — "${preview}"`);
    try {
      const result = await archivePost(post, token);
      if (result.status === 'archived') {
        archived++;
        totalBytes += (result.bytes || 0);
        log(`  ✓ archived (${result.mediaCount} media, ${formatBytes(result.bytes || 0)})`);
      } else {
        skipped++;
        log(`  - skipped (already archived; pass --force to re-archive)`);
      }
    } catch (e) {
      failed++;
      log(`  ✗ FAILED: ${e.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 300));
  }

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`DONE: ${archived} archived · ${skipped} skipped · ${failed} failed`);
  log(`Downloaded: ${formatBytes(totalBytes)} → ${ARCHIVE_DIR}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

runArchive().catch(e => { log(`FATAL: ${e.message}`, 'ERROR'); process.exit(1); });
