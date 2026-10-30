type Target = { value: string; name: string };
type Photo = { id: string; origin: string; albumId: string | null; outcome: string; project?: { name: string; reason: string; action: string } | null; potentialManualDuplicates?: string[] };
type Batch = { albums: { id: string; name: string }[]; posts: { id: string }[]; photos: Photo[]; errors: { task: string; error: string }[]; complete: boolean; nextState?: unknown; busy?: boolean };
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function initCompleteDiscoveryUI(options: {
  request: (body: unknown) => Promise<Batch>;
  targets: () => Target[];
  refreshed: () => Promise<void>;
  status: (message: string) => void;
}) {
  const panel = document.getElementById('fb-backfill');
  const preview = document.getElementById('fb-backfill-dry') as HTMLButtonElement;
  const run = document.getElementById('fb-backfill-run') as HTMLButtonElement;
  const stop = document.getElementById('fb-backfill-stop') as HTMLButtonElement;
  if (!panel || !preview || !run || !stop) return;
  let stopped = false;
  let previewComplete = false;
  let state: unknown = null;
  let albums = new Map<string, string>();
  let posts = new Set<string>();
  let photos = new Map<string, Photo & { origins: Set<string> }>();
  let errors: Batch['errors'] = [];
  const mappings: Record<string, string> = {};
  run.disabled = true;

  function render(label: string) {
    const rows = [...photos.values()];
    const groups = new Map<string, number>();
    for (const p of rows) if (p.project) groups.set(p.project.name, (groups.get(p.project.name) || 0) + 1);
    panel!.innerHTML = `<p><strong>${escape(label)}</strong></p><dl class="fb-stats">
      <div><dt>Albums scanned</dt><dd>${albums.size}</dd></div>
      <div><dt>Posts scanned</dt><dd>${posts.size}</dd></div>
      <div><dt>Unique photos</dt><dd>${photos.size}</dd></div>
      <div><dt>Only in albums</dt><dd>${rows.filter(p => p.origins.has('album') && !p.origins.has('post')).length}</dd></div>
      <div><dt>In albums and posts</dt><dd>${rows.filter(p => p.origins.has('album') && p.origins.has('post')).length}</dd></div>
      <div><dt>Already imported</dt><dd>${rows.filter(p => p.outcome === 'existing').length}</dd></div>
      <div><dt>Suppressed</dt><dd>${rows.filter(p => p.outcome === 'suppressed').length}</dd></div>
      <div><dt>Imported this run</dt><dd>${rows.filter(p => p.outcome === 'imported').length}</dd></div>
      <div><dt>Possible manual duplicates</dt><dd>${rows.filter(p => p.potentialManualDuplicates?.length).length}</dd></div>
    </dl><p class="hint">Counts cover accessible content scanned so far. Duplicate candidates use stored Facebook IDs or filenames; visually identical or recompressed images are not compared. Preview does not download or publish originals.</p>
    <h3>Proposed galleries</h3><ul>${[...groups].map(([name, count]) => `<li>${escape(name)}: ${count} photo(s)</li>`).join('')}</ul>
    <details><summary>Review album destinations before importing</summary><p>Choose an existing gallery or Recent Project Updates. Automatic uses the proposed matching rules. These choices affect new imports; existing manual photo assignments remain intact.</p>
    ${[...albums].map(([id, name]) => `<label>${escape(name)} <select data-album="${escape(id)}"><option value="">Automatic</option><option value="recent" ${mappings[id] === 'recent' ? 'selected' : ''}>Recent Project Updates</option>${options.targets().map(t => `<option value="${escape(t.value)}" ${mappings[id] === t.value ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</select></label>`).join('<br>')}</details>
    ${errors.length ? `<h3>Incomplete results</h3><ul>${errors.map(e => `<li>${escape(e.task)}: ${escape(e.error)}</li>`).join('')}</ul><p>Import remains unavailable until preview completes without errors. No failed page is skipped.</p>` : ''}`;
  }
  panel.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (!select.dataset.album) return;
    if (select.value) mappings[select.dataset.album] = select.value;
    else delete mappings[select.dataset.album];
    previewComplete = false;
    state = null;
    run.disabled = true;
    options.status('Mapping changed. Run Preview again to validate all destinations before importing.');
  });

  async function scan(dry: boolean) {
    if (!dry && (!previewComplete || !window.confirm('Import and publish the historical album and post photos using the reviewed mappings? Existing manual photos and suppression choices are preserved.'))) return;
    stopped = false;
    if (dry) previewComplete = false;
    preview.disabled = run.disabled = true;
    stop.hidden = false;
    if (!dry || !state) { albums = new Map(); posts = new Set(); photos = new Map(); }
    errors = [];
    let first = true;
    try {
      while (!stopped) {
        const batch = await options.request({ discovery: true, dryRun: dry, ...(dry && state ? { state } : {}), mappings, ...(!dry ? { authorizeHistorical: true, retry: first } : {}) });
        if (batch.busy) { options.status('Another scan is running, or a retry is waiting for its backoff. Try again later.'); break; }
        for (const a of batch.albums) albums.set(a.id, a.name);
        for (const p of batch.posts) posts.add(p.id);
        for (const p of batch.photos) {
          const old = photos.get(p.id);
          const origins = old?.origins || new Set<string>();
          origins.add(p.origin);
          // Reencountering a photo must not inflate counts or erase its proposal.
          const project = old?.project && old.project.action !== 'recent' ? old.project : p.project || old?.project;
          photos.set(p.id, { ...old, ...p, project, outcome: old?.outcome === 'imported' ? 'imported' : p.outcome, origins });
        }
        errors.push(...batch.errors);
        if (dry) state = batch.complete ? null : batch.nextState;
        render(batch.complete ? 'Complete' : 'Scanning albums and posts…');
        if (errors.length) break;
        if (batch.complete) { if (dry) previewComplete = true; break; }
        first = false;
      }
      if (stopped) render('Stopped after the current batch; preview can resume');
    } catch (e) {
      options.status(`${dry ? 'Preview' : 'Import'} stopped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      preview.disabled = false;
      run.disabled = !previewComplete;
      stop.hidden = true;
      if (!dry) await options.refreshed();
    }
  }
  preview.addEventListener('click', () => void scan(true));
  run.addEventListener('click', () => void scan(false));
  stop.addEventListener('click', () => { stopped = true; });
}
