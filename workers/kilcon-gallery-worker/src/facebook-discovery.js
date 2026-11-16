// Shared bounded traversal. No storage, credentials, downloads or publication
// live here. Preview keeps this continuation in the browser; imports keep it
// in D1. Never follow a Graph-provided URL (it may include an access token).
import { albumCollectionKind } from './facebook-album-matching.js';
const ID = /^[0-9_]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,2048}$/;
const EDGES = /^(albums|photos|posts|attachments|subattachments)$/;
export const DISCOVERY_POST_FIELDS = 'id,message,created_time,permalink_url,from';
const PHOTO_FIELDS = 'id,name,created_time,link,from,album{id,name},images';
const ALBUM_FIELDS = 'id,name,description,created_time,updated_time,from';

export function initialDiscovery(pageId, cutoff = null) {
  return { version: 1, pageId, cutoff, contexts: {}, tasks: [
    { edge: 'albums', id: pageId }, { edge: 'posts', id: pageId },
  ] };
}

export function validateDiscovery(state, pageId) {
  if (!state || state.version !== 1 || state.pageId !== pageId ||
      !Array.isArray(state.tasks) || state.tasks.length > 500 ||
      JSON.stringify(state).length > 200000 ||
      (state.cutoff !== null && !Number.isFinite(Date.parse(state.cutoff)))) throw new Error('Invalid discovery continuation');
  if (state.contexts && (typeof state.contexts !== 'object' || Array.isArray(state.contexts) || Object.keys(state.contexts).length > 50 || Object.keys(state.contexts).some(id => !ID.test(id)))) throw new Error('Invalid post contexts');
  for (const t of state.tasks) {
    if (!ID.test(t.id || '') || !(t.edge === 'photo' || EDGES.test(t.edge || '')) ||
        (t.after && !CURSOR.test(t.after)) ||
        (t.post?.id && !ID.test(t.post.id)) || (t.album?.id && !ID.test(t.album.id))) throw new Error('Invalid discovery task');
  }
  return state;
}

function continuation(page, task, version) {
  if (!page?.paging?.next) return null;
  const url = new URL(page.paging.next);
  if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || url.username || url.password || url.port) throw new Error('Unsafe Graph pagination URL');
  const match = url.pathname.match(/^\/v\d+\.\d+\/([0-9_]{1,64})\/(albums|photos|posts|attachments|subattachments)\/?$/);
  if (!match || !url.pathname.startsWith(`/${version}/`)) throw new Error('Unsupported Graph pagination path; coverage incomplete');
  const after = page.paging.cursors?.after || url.searchParams.get('after');
  if (!after || !CURSOR.test(after)) throw new Error('Missing or unsupported Graph cursor; coverage incomplete');
  // A nested subattachment edge can use an attachment node ID instead of a post ID.
  if (match[2] !== task.edge || (task.edge !== 'subattachments' && match[1] !== task.id)) throw new Error('Unexpected Graph pagination edge');
  if (match[1] === task.id && after === task.after) throw new Error('Graph pagination cursor did not advance; coverage incomplete');
  return { ...task, id: match[1], after };
}

function attachments(page, post, tasks, version, edge = 'attachments', id = post.id) {
  const reference = { id: post.id };
  const next = continuation(page, { edge, id, post: reference }, version);
  if (next) tasks.push(next);
  for (const a of page?.data || []) {
    if (a.type === 'photo' && ID.test(a.target?.id || '')) tasks.push({ edge: 'photo', id: a.target.id, post: reference, origin: 'post' });
    if (a.subattachments) attachments(a.subattachments, post, tasks, version, 'subattachments', id);
  }
}

export async function discoveryBatch(state, { graph, visit, version, budget, renew = async () => {}, maxSteps = 12, canContinue = () => true, review = false }) {
  const report = { albums: [], posts: [], photos: [], errors: [], complete: false,
    coverage: { albumPages: 0, postPages: 0, postsReturned: 0, postsUnknownAuthor: 0, postsOtherAuthor: 0 } };
  state.contexts ||= {};
  // Store a post caption once, not on every photo task in a large post.
  for (const task of state.tasks) if (task.post && Object.hasOwn(task.post, 'message')) {
    state.contexts[task.post.id] = task.post;
    task.post = { id: task.post.id };
  }
  if (review) report.discoveredPhotos = [];
  for (let n = 0; n < maxSteps && state.tasks.length && budget.remaining >= 4 && canContinue(); n++) {
    const queued = state.tasks[0];
    const task = { ...queued, post: state.contexts[queued.post?.id] || queued.post };
    const coverageBeforeTask = review ? { ...report.coverage } : null;
    try {
      await renew();
      if (task.edge === 'photo') {
        const photo = await graph(task.id, { fields: PHOTO_FIELDS }, budget);
        if (photo.id !== task.id) throw new Error('Graph returned an unexpected photo ID');
        // Absence of ownership information is not permission to import visitor content.
        if (photo.from?.id !== state.pageId) throw new Error('Photo ownership could not be verified');
        const result = await visit(photo, task, state.cutoff, budget);
        report.photos.push({ id: photo.id, origin: task.origin, sourceAlbumId: task.album?.id || null, albumId: photo.album?.id || task.album?.id || null, ...result });
        if (review) report.photos.at(-1).sourcePostId = task.post?.id || null;
        state.tasks.shift();
        continue;
      }
      const fields = task.edge === 'albums' ? ALBUM_FIELDS : task.edge === 'photos' ? 'id,created_time' : task.edge === 'posts' ? DISCOVERY_POST_FIELDS : 'type,target,subattachments.limit(10){type,target}';
      const page = await graph(`${task.id}/${task.edge}`, { fields, limit: 10, after: task.after }, budget);
      if (!Array.isArray(page?.data)) throw new Error('Graph edge returned no data array; coverage incomplete');
      const children = [];
      const next = continuation(page, task, version);
      if (task.edge === 'albums') report.coverage.albumPages++;
      if (task.edge === 'posts') report.coverage.postPages++;
      for (const item of page.data) {
        if (task.edge === 'albums') {
          if (!ID.test(item.id || '')) throw new Error('Invalid album ID');
          if (item.from?.id && item.from.id !== state.pageId) continue;
          const album = { id: item.id, name: String(item.name || '').slice(0, 200), description: String(item.description || '').slice(0, 5000), created_time: item.created_time || null, updated_time: item.updated_time || null };
          report.albums.push({ ...album, collection: albumCollectionKind(album.name) });
          children.push({ edge: 'photos', id: item.id, album });
        } else if (task.edge === 'photos') {
          if (!ID.test(item.id || '')) throw new Error('Invalid photo ID');
          if (review) report.discoveredPhotos.push({ id: item.id, origin: 'album', sourceAlbumId: task.id });
          // Old album pages are cheap ID/date inventories. No need to fetch
          // full metadata for photos outside reconciliation's approved range.
          if (state.cutoff && item.created_time && Number.isFinite(Date.parse(item.created_time)) && Date.parse(item.created_time) < Date.parse(state.cutoff)) continue;
          children.push({ edge: 'photo', id: item.id, album: task.album, origin: 'album' });
        } else if (task.edge === 'posts') {
          report.coverage.postsReturned++;
          const author = item.from?.id == null ? '' : String(item.from.id);
          if (!author) { report.coverage.postsUnknownAuthor++; continue; }
          if (author !== state.pageId) { report.coverage.postsOtherAuthor++; continue; }
          const post = { id: item.id, message: String(item.message || '').slice(0, 5000), created_time: item.created_time || null, permalink_url: item.permalink_url || null, from: item.from };
          if (!ID.test(post.id || '')) throw new Error('Invalid post ID');
          state.contexts[post.id] = post;
          report.posts.push({ id: post.id, createdTime: post.created_time });
          if (item.attachments) attachments(item.attachments, post, children, version);
          else children.push({ edge: 'attachments', id: post.id, post: { id: post.id } });
        }
      }
      if (task.edge === 'attachments' || task.edge === 'subattachments') {
        // continuation already added below; process this page's nested items once.
        attachments({ data: page.data }, task.post, children, version, task.edge, task.id);
      }
      if (review && task.edge !== 'photos') {
        for (const photo of children) if (photo.edge === 'photo') {
          report.discoveredPhotos.push({ id: photo.id, origin: 'post', sourcePostId: photo.post.id });
        }
      }
      // Depth-first traversal bounds pending tasks to a few pages, even for huge albums.
      if (next) children.push(next.post ? { ...next, post: { id: next.post.id } } : next);
      state.tasks.splice(0, 1, ...children);
    } catch (e) {
      if (e.name === 'BudgetExhausted') break;
      if (coverageBeforeTask) report.coverage = coverageBeforeTask;
      const failure = { task: `${task.id}/${task.edge}`, error: e.message };
      if (review) {
        if (Number.isInteger(e.graphStatus)) failure.httpStatus = e.graphStatus;
        if (Number.isInteger(e.graphCode)) failure.graphCode = e.graphCode;
        if (Number.isInteger(e.graphSubcode)) failure.graphSubcode = e.graphSubcode;
        if (e.name === 'TimeoutError') failure.timedOut = true;
      }
      report.errors.push(failure);
      // Retain the exact failed task. No cursor advances over missing content.
      break;
    }
  }
  report.complete = state.tasks.length === 0;
  const needed = new Set(state.tasks.map(t => t.post?.id).filter(Boolean));
  for (const id of Object.keys(state.contexts)) if (!needed.has(id)) delete state.contexts[id];
  report.nextState = state;
  return report;
}
