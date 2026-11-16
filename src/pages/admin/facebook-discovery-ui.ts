import { buildReviewReport, isRetryablePreviewStatus } from '../../utils/facebook-review-report';
import type { Album, AlbumTarget, Coverage, CoverageError, Photo, ReviewedPhoto } from '../../utils/facebook-review-report';
export type { AlbumTarget } from '../../utils/facebook-review-report';
const emptyCoverage = (): Coverage => ({ albumPages: 0, postPages: 0, postsReturned: 0, postsUnknownAuthor: 0, postsOtherAuthor: 0 });
const targetLabel = (t: AlbumTarget) => `${t.name} — ${t.prefix || `${t.category} / ${t.slug} (Facebook)`}`;
type Batch = { albums: Album[]; posts: { id: string }[]; photos: Photo[]; discoveredPhotos?: Photo[]; errors: CoverageError[]; warnings?: string[]; coverage?: Coverage; partial?: boolean; complete: boolean; nextState?: unknown; busy?: boolean; coveragePhase?: string; duplicateCandidates?: { id: string; key: string }[] };
type RequestFailure = Error & { status?: number; rayId?: string };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function initCompleteDiscoveryUI(options: {
  request: (body: unknown) => Promise<Batch>;
  targets: () => AlbumTarget[];
  importEnabled: () => boolean;
  refreshed: () => Promise<void>;
  status: (message: string) => void;
}) {
  const panel = document.getElementById('fb-backfill');
  const preview = document.getElementById('fb-backfill-dry') as HTMLButtonElement;
  const run = document.getElementById('fb-backfill-run') as HTMLButtonElement;
  const stop = document.getElementById('fb-backfill-stop') as HTMLButtonElement;
  if (!panel || !preview || !run || !stop) return;
  const draftKey = 'kilcon-facebook-album-mapping-v1';
  let active = false;
  let filter = '';
  let selected = '';
  let coverage = emptyCoverage();
  let warnings: string[] = [];
  const byAlbum = new Map<string, Map<string, Photo>>();
  let stopped = false;
  let previewComplete = false;
  let draftChanged = false;
  let phase = 'facebook';
  let isPreview = false;
  let state: unknown = null;
  let albums = new Map<string, Album>();
  let posts = new Set<string>();
  let photos = new Map<string, ReviewedPhoto>();
  const duplicates = new Map<string, Set<string>>();
  const duplicateKeys = (id: string) => [...(duplicates.get(id) || [])];
  let errors: Batch['errors'] = [];
  const mappings: Record<string, string> = Object.create(null);
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey) || '{}');
    for (const [id, value] of Object.entries(draft)) if (/^[0-9_]{1,64}$/.test(id) && typeof value === 'string') mappings[id] = value;
  } catch { /* Storage may be unavailable; keep the in-memory draft. */ }
  run.disabled = true;

  function needsDecision(id: string, album: Album) {
    if (mappings[id]) return false;
    return [...(byAlbum.get(id)?.values() ?? [])].some(p => p.project &&
      (['review-album', 'ambiguous-album'].includes(p.project.reason) ||
       (album.collection === 'generic' && p.project.action === 'recent')));
  }

  const unresolvedAlbums = () => [...albums].filter(([id, album]) => needsDecision(id, album));

  function render(label: string) {
    const rows = [...photos.values()];
    const groups = new Map<string, number>();
    for (const p of rows) if (p.project) groups.set(p.project.name, (groups.get(p.project.name) || 0) + 1);
    panel!.innerHTML = `<p><strong>${escape(label)}</strong></p>
      ${options.importEnabled() ? '' : '<p class="hint">Historical importing is disabled during preview review.</p>'}<dl class="fb-stats">
      <div><dt>Albums scanned</dt><dd>${albums.size}</dd></div>
      <div><dt>Post pages read</dt><dd>${coverage.postPages}</dd></div>
      <div><dt>Posts returned / verified</dt><dd>${coverage.postsReturned} / ${posts.size}</dd></div>
      <div><dt>Posts skipped</dt><dd>${coverage.postsUnknownAuthor} unverified author · ${coverage.postsOtherAuthor} other author</dd></div>
      <div><dt>Unique photos</dt><dd>${photos.size}</dd></div>
      <div><dt>Seen in albums, not in scanned posts</dt><dd>${rows.filter(p => p.origins.has('album') && !p.origins.has('post')).length}</dd></div>
      <div><dt>In albums and posts</dt><dd>${rows.filter(p => p.origins.has('album') && p.origins.has('post')).length}</dd></div>
      <div><dt>Already imported</dt><dd>${rows.filter(p => p.outcome === 'existing').length}</dd></div>
      <div><dt>Suppressed</dt><dd>${rows.filter(p => p.outcome === 'suppressed').length}</dd></div>
      <div><dt>Imported this run</dt><dd>${rows.filter(p => p.outcome === 'imported').length}</dd></div>
      <div><dt>Possible manual duplicates</dt><dd>${rows.filter(p => duplicates.has(p.id)).length}</dd></div>
      <div><dt>Albums needing a decision</dt><dd>${unresolvedAlbums().length}</dd></div>
    </dl><p class="hint">Counts cover accessible content scanned so far. Duplicate candidates use stored Facebook IDs or filenames; visually identical or recompressed images are not compared. Preview does not download or publish originals.</p>
    ${isPreview ? `<div class="actions fb-review-actions">
      <button type="button" class="btn-small" data-export-review aria-describedby="fb-export-status" ${active ? 'disabled' : ''}>Download review report (JSON)</button>
      <span id="fb-export-status" class="hint">${previewComplete ? 'Complete scan' : 'Incomplete scan'}${draftChanged ? ' · Destination drafts changed since scanning' : ''}</span>
    </div>` : ''}
    <h3>Proposed galleries</h3><ul>${[...groups].map(([name, count]) => `<li>${escape(name)}: ${count} photo(s)</li>`).join('')}</ul>
    <div id="fb-album-review"></div>
    ${warnings.length ? `<h3>Coverage warnings</h3><ul>${warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul>` : ''}
    ${errors.length ? `<h3>Incomplete results</h3><ul>${errors.map(e => `<li>${escape(e.task)}: ${escape(e.error)}</li>`).join('')}</ul>` : ''}`;
    renderReview();
  }

  function renderReview() {
    const section = panel!.querySelector('#fb-album-review');
    if (!section || !albums.size) return;
    const allTargets = options.targets();
    const describe = (id: string) => {
      const records = [...(byAlbum.get(id)?.values() ?? [])];
      const proposals = records.filter(p => p.project).map(p => p.project!);
      const destinations = [...new Set(proposals.map(p => `${p.name} (${p.action === 'create' ? 'new project' : p.action === 'link' || p.action === 'reuse' ? 'existing gallery' : p.action === 'exclude' ? 'excluded' : 'updates'})`))];
      const candidates = new Map(proposals.flatMap(p => p.candidates || []).map(t => [t.value, t]));
      const already = records.filter(p => p.outcome === 'existing').length;
      const album = albums.get(id);
      const review = !!album && needsDecision(id, album);
      return { records, proposals, destinations, candidates, already, review };
    };
    const visible = [...albums].filter(([,album]) => album.name.toLowerCase().includes(filter.toLowerCase()));
    const current = selected && albums.has(selected) ? describe(selected) : null;
    const currentValue = mappings[selected] || '';
    const oldOption = currentValue && !['recent','exclude'].includes(currentValue) && !allTargets.some(t=>t.value===currentValue)
      ? `<option value="${escape(currentValue)}" selected>${escape(currentValue)} (saved draft)</option>` : '';
    const byCategory = new Map<string, AlbumTarget[]>();
    for (const t of allTargets) {
      const group = t.category === 'projects' ? 'Projects' : t.category;
      if (!byCategory.has(group)) byCategory.set(group, []);
      byCategory.get(group)!.push(t);
    }
    const edit = current ? `<fieldset><legend>Destination for ${escape(albums.get(selected)?.name)}</legend>
      <label>Destination <select data-destination>
        <option value="">Automatic proposal</option>
        <option value="recent"${currentValue === 'recent' ? ' selected' : ''}>Recent Project Updates</option>
        <option value="exclude"${currentValue === 'exclude' ? ' selected' : ''}>Exclude from historical import</option>
        ${oldOption}
        ${[...byCategory].map(([category,targets])=>`<optgroup label="${escape(category)}">${targets.sort((a,b)=>a.name.localeCompare(b.name)).map(t=>`<option value="${escape(t.value)}"${t.value===currentValue?' selected':''}>${escape(targetLabel(t))}</option>`).join('')}</optgroup>`).join('')}
      </select></label>
      <p class="hint">Selection is a draft in this tab. It does not change any gallery. Re-run the preview after editing.</p>
      <button type="button" data-close-editor>Done</button></fieldset>` : '';
    section.innerHTML = `<h3>Album review</h3><label>Filter albums <input type="search" data-album-filter value="${escape(filter)}"></label>
      ${edit}
      <div class="table-wrap"><table class="fb-table"><thead><tr><th scope="col">Album</th><th scope="col">Unique photos</th><th scope="col">Proposed destination</th><th scope="col">Review</th><th scope="col">Action</th></tr></thead><tbody>
      ${visible.map(([id,album])=>{
        const name = album.name;
        const { records,destinations,candidates,already,review } = describe(id);
        const saved = mappings[id];
        const target = allTargets.find(t=>t.value===saved);
        const draft = saved ? `<br><strong>Draft:</strong> ${escape(saved === 'exclude' ? 'Exclude from historical import' : saved === 'recent' ? 'Recent Project Updates' : target ? targetLabel(target) : saved)}` : '';
        return `<tr><th scope="row">${escape(name)}</th><td>${records.length}${already ? ` (${already} already imported)` : ''}</td><td>${escape(destinations.join('; ') || (already ? 'Already imported' : 'No proposal yet'))}${draft}</td>
          <td>${album.collection === 'branding' ? 'Branding album — exclude' : album.collection === 'generic' ? 'Mixed-use album — review or exclude' : review ? 'Needs review' : ''}${candidates.size ? `<ul>${[...candidates.values()].map(t=>`<li>${escape(targetLabel(t))}</li>`).join('')}</ul>` : ''}</td>
          <td><button type="button" data-edit-album="${escape(id)}" aria-label="Change destination for ${escape(name)}" ${active?'disabled':''}>Change destination</button></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  panel.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (!input.hasAttribute('data-album-filter')) return;
    const caret = input.selectionStart;
    filter = input.value;
    renderReview();
    const next = panel.querySelector<HTMLInputElement>('[data-album-filter]');
    next?.focus();
    if (caret !== null) next?.setSelectionRange(caret, caret);
  });
  panel.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (active || !button) return;
    if (button.hasAttribute('data-export-review')) {
      const report = buildReviewReport({ complete: previewComplete, draftChanged, phase, coverage, warnings, errors,
        albums, posts, photos, byAlbum, mappings, duplicateKeys, needsDecision });
      const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = `kilcon-facebook-album-review-${report.status}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } else if (button.dataset.editAlbum) {
      selected = button.dataset.editAlbum;
      renderReview();
      (panel.querySelector('[data-destination]') as HTMLSelectElement | null)?.focus();
    } else if (button.hasAttribute('data-close-editor')) {
      const id = selected;
      selected = '';
      renderReview();
      panel.querySelector<HTMLButtonElement>(`[data-edit-album="${id}"]`)?.focus();
    }
  });
  panel.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (active || !selected || !select.hasAttribute('data-destination')) return;
    if (select.value) mappings[selected] = select.value;
    else delete mappings[selected];
    try { sessionStorage.setItem(draftKey, JSON.stringify(mappings)); } catch { /* in-memory draft still available */ }
    draftChanged = true;
    state = null;
    preview.textContent = 'Preview (dry run)';
    run.disabled = true;
    const exportStatus = panel.querySelector('#fb-export-status');
    if (exportStatus) exportStatus.textContent = `${previewComplete ? 'Complete scan' : 'Incomplete scan'} · Destination drafts changed since scanning`;
    renderReview();
    (panel.querySelector('[data-destination]') as HTMLSelectElement | null)?.focus();
    options.status('Draft updated. Run Preview again before importing.');
  });

  function recordPhoto(p: Photo) {
    const source = p.sourceAlbumId || (p.origin === 'album' ? p.albumId : null);
    if (source) {
      const members = byAlbum.get(source) ?? new Map<string, Photo>();
      if (p.outcome || !members.has(p.id)) members.set(p.id, p);
      byAlbum.set(source, members);
    }
    const old = photos.get(p.id);
    const origins = old?.origins || new Set<string>();
    const postIds = old?.postIds || new Set<string>();
    const reportedAlbumIds = old?.reportedAlbumIds || new Set<string>();
    origins.add(p.origin);
    if (p.sourcePostId) postIds.add(p.sourcePostId);
    if (p.albumId) reportedAlbumIds.add(p.albumId);
    const project = old?.project && old.project.action !== 'recent' ? old.project : p.project || old?.project;
    const outcome = old?.outcome === 'imported' ? 'imported' : p.outcome || old?.outcome;
    photos.set(p.id, { ...old, ...p, project, outcome, origins, postIds, reportedAlbumIds });
  }

  async function scan(dry: boolean) {
    if (active || (!dry && (!options.importEnabled() || !previewComplete || draftChanged || unresolvedAlbums().length || !window.confirm('Import and publish the historical album and post photos using the reviewed mappings? Existing manual photos and suppression choices are preserved.')))) return;
    stopped = false;
    active = true;
    selected = "";
    isPreview = dry;
    if (dry) previewComplete = false;
    preview.disabled = run.disabled = true;
    stop.hidden = false;
    if (!dry || !state) {
      albums = new Map(); posts = new Set(); photos = new Map(); byAlbum.clear(); duplicates.clear();
      coverage = emptyCoverage(); warnings = []; phase = 'facebook'; draftChanged = false;
    }
    errors = [];
    let first = true;
    let singleStep = false;
    let lastRender = performance.now();
    render('Scanning albums and posts…');
    try {
      while (!stopped) {
        const body = { discovery: true, dryRun: dry, ...(dry && state ? { state } : {}), mappings, ...(!dry ? { authorizeHistorical: true, retry: first } : {}) };
        let batch: Batch;
        try {
          batch = await options.request({ ...body, ...(singleStep ? { singleStep: true } : {}) });
        } catch (e) {
          if (!dry || stopped || !isRetryablePreviewStatus((e as RequestFailure).status)) throw e;
          singleStep = true;
          options.status('Preview request interrupted. Retrying the same checkpoint with a smaller batch.');
          await new Promise(resolve => window.setTimeout(resolve, 1000));
          if (stopped) break;
          batch = await options.request({ ...body, singleStep: true });
        }
        if (batch.busy) { options.status('Another scan is running, or a retry is waiting for its backoff. Try again later.'); break; }
        if (!Array.isArray(batch.albums) || !Array.isArray(batch.posts) || !Array.isArray(batch.photos) ||
            !Array.isArray(batch.errors) || (dry && !batch.complete && !batch.nextState)) {
          throw new Error('The preview response was incomplete. Resume to retry the last checkpoint.');
        }
        if (batch.coverage) for (const key of Object.keys(coverage) as (keyof Coverage)[]) coverage[key] += batch.coverage[key] || 0;
        for (const a of batch.albums) albums.set(a.id, a);
        for (const p of batch.posts) posts.add(p.id);
        for (const p of batch.discoveredPhotos || []) recordPhoto(p);
        for (const p of batch.photos) recordPhoto(p);
        for (const candidate of batch.duplicateCandidates || []) {
          if (!photos.has(candidate.id)) continue;
          const matches = duplicates.get(candidate.id) ?? new Set<string>();
          if (matches.size < 20) matches.add(candidate.key);
          duplicates.set(candidate.id, matches);
        }
        phase = batch.coveragePhase || phase;
        errors.push(...batch.errors);
        warnings = [...new Set([...warnings, ...(batch.warnings || [])])];
        if (dry) state = batch.complete ? null : batch.nextState;
        if (dry && batch.complete) previewComplete = !batch.partial && !errors.length && !warnings.length;
        if (batch.complete || errors.length || performance.now() - lastRender >= 250) {
          render(errors.length || (batch.complete && warnings.length) ? 'Partial — review coverage'
            : batch.complete ? 'Complete' : phase === 'manual-inventory' ? 'Checking for possible manual duplicates…' : 'Scanning albums and posts…');
          lastRender = performance.now();
        }
        if (errors.length) break;
        if (batch.complete) break;
        first = false;
      }
      if (stopped && !previewComplete) render('Stopped after the current batch; preview can resume');
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const failure = e as RequestFailure;
      errors.push({ task: 'Preview request', error, httpStatus: failure.status, rayId: failure.rayId, timedOut: failure.name === 'TimeoutError' });
      render('Partial — request failed');
      options.status(`${dry ? 'Preview' : 'Import'} stopped: ${error}`);
    } finally {
      active = false;
      renderReview();
      const download = panel!.querySelector<HTMLButtonElement>('[data-export-review]');
      if (download) download.disabled = false;
      preview.disabled = false;
      preview.textContent = state ? 'Resume preview (dry run)' : 'Preview (dry run)';
      run.disabled = !options.importEnabled() || !previewComplete || draftChanged || unresolvedAlbums().length > 0;
      stop.hidden = true;
      if (!dry) await options.refreshed();
    }
  }
  preview.addEventListener('click', () => void scan(true));
  run.addEventListener('click', () => void scan(false));
  stop.addEventListener('click', () => { stopped = true; });
}
