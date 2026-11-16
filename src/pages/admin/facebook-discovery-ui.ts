export type AlbumTarget = { value: string; name: string; category: string; source: string; prefix?: string | null; slug?: string };
type Proposal = { name: string; reason: string; action: string; candidates?: AlbumTarget[]; destination?: string | null };
type Coverage = { albumPages: number; postPages: number; postsReturned: number; postsUnknownAuthor: number; postsOtherAuthor: number };
const emptyCoverage = (): Coverage => ({ albumPages: 0, postPages: 0, postsReturned: 0, postsUnknownAuthor: 0, postsOtherAuthor: 0 });
const targetLabel = (t: AlbumTarget) => `${t.name} — ${t.prefix || `${t.category} / ${t.slug} (Facebook)`}`;
type Photo = { id: string; origin: string; albumId: string | null; outcome: string; sourceAlbumId?: string | null; project?: Proposal | null; potentialManualDuplicates?: string[] };
type Album = { id: string; name: string; collection?: 'branding' | 'generic' | 'project' };
type Batch = { albums: Album[]; posts: { id: string }[]; photos: Photo[]; errors: { task: string; error: string }[]; warnings?: string[]; coverage?: Coverage; partial?: boolean; complete: boolean; nextState?: unknown; busy?: boolean };
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
  let state: unknown = null;
  let albums = new Map<string, Album>();
  let posts = new Set<string>();
  let photos = new Map<string, Photo & { origins: Set<string> }>();
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
      <div><dt>Possible manual duplicates</dt><dd>${rows.filter(p => p.potentialManualDuplicates?.length).length}</dd></div>
      <div><dt>Albums needing a decision</dt><dd>${unresolvedAlbums().length}</dd></div>
    </dl><p class="hint">Counts cover accessible content scanned so far. Duplicate candidates use stored Facebook IDs or filenames; visually identical or recompressed images are not compared. Preview does not download or publish originals.</p>
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
      <button type="button" data-export-review ${active ? 'disabled' : ''}>Download review report</button>
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
      const report = { complete: previewComplete, coverage, warnings, errors,
        albums: [...albums].map(([id, album]) => ({ id, name: album.name, collection: album.collection, draft: mappings[id] || null,
          photos: [...(byAlbum.get(id)?.values() ?? [])].map(p => ({ id: p.id, outcome: p.outcome, project: p.project,
            alsoFoundInPosts: photos.get(p.id)?.origins.has('post') ?? false,
            possibleManualDuplicates: p.potentialManualDuplicates ?? [] })) })) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'kilcon-facebook-album-review.json';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    previewComplete = false;
    state = null;
    run.disabled = true;
    renderReview();
    (panel.querySelector('[data-destination]') as HTMLSelectElement | null)?.focus();
    options.status('Draft updated. Run Preview again before importing.');
  });

  async function scan(dry: boolean) {
    if (!dry && (!options.importEnabled() || !previewComplete || unresolvedAlbums().length || !window.confirm('Import and publish the historical album and post photos using the reviewed mappings? Existing manual photos and suppression choices are preserved.'))) return;
    stopped = false;
    active = true;
    selected = "";
    if (dry) previewComplete = false;
    preview.disabled = run.disabled = true;
    stop.hidden = false;
    if (!dry || !state) { albums = new Map(); posts = new Set(); photos = new Map(); byAlbum.clear(); coverage = emptyCoverage(); }
    errors = [];
    warnings = [];
    let first = true;
    try {
      while (!stopped) {
        const batch = await options.request({ discovery: true, dryRun: dry, ...(dry && state ? { state } : {}), mappings, ...(!dry ? { authorizeHistorical: true, retry: first } : {}) });
        if (batch.busy) { options.status('Another scan is running, or a retry is waiting for its backoff. Try again later.'); break; }
        if (batch.coverage) for (const key of Object.keys(coverage) as (keyof Coverage)[]) coverage[key] += batch.coverage[key] || 0;
        for (const a of batch.albums) albums.set(a.id, a);
        for (const p of batch.posts) posts.add(p.id);
        for (const p of batch.photos) {
          const source = p.sourceAlbumId || (p.origin === 'album' ? p.albumId : null);
          if (source) {
            const members = byAlbum.get(source) ?? new Map<string, Photo>();
            members.set(p.id, p);
            byAlbum.set(source, members);
          }
          const old = photos.get(p.id);
          const origins = old?.origins || new Set<string>();
          origins.add(p.origin);
          // Reencountering a photo must not inflate counts or erase its proposal.
          const project = old?.project && old.project.action !== 'recent' ? old.project : p.project || old?.project;
          photos.set(p.id, { ...old, ...p, project, outcome: old?.outcome === 'imported' ? 'imported' : p.outcome, origins });
        }
        errors.push(...batch.errors);
        warnings.push(...(batch.warnings || []));
        if (dry) state = batch.complete ? null : batch.nextState;
        render(batch.partial || errors.length ? 'Partial — review coverage' : batch.complete ? 'Complete' : 'Scanning albums and posts…');
        if (errors.length) break;
        if (batch.complete) { if (dry) previewComplete = !batch.partial && !warnings.length; break; }
        first = false;
      }
      if (stopped) render('Stopped after the current batch; preview can resume');
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      errors.push({ task: 'Preview request', error });
      render('Partial — request failed');
      options.status(`${dry ? 'Preview' : 'Import'} stopped: ${error}`);
    } finally {
      active = false;
      renderReview();
      preview.disabled = false;
      run.disabled = !options.importEnabled() || !previewComplete || unresolvedAlbums().length > 0;
      stop.hidden = true;
      if (!dry) await options.refreshed();
    }
  }
  preview.addEventListener('click', () => void scan(true));
  run.addEventListener('click', () => void scan(false));
  stop.addEventListener('click', () => { stopped = true; });
}
