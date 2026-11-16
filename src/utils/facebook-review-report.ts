export type AlbumTarget = { value: string; name: string; category: string; source: string; prefix?: string | null; slug?: string };
export type Proposal = { name: string; reason: string; action: string; candidates?: AlbumTarget[]; destination?: string | null };
export type Coverage = { albumPages: number; postPages: number; postsReturned: number; postsUnknownAuthor: number; postsOtherAuthor: number };
export type CoverageError = { task: string; error: string; httpStatus?: number; graphCode?: number; graphSubcode?: number; timedOut?: boolean; rayId?: string };
export type Photo = { id: string; origin: string; albumId?: string | null; outcome?: string; sourceAlbumId?: string | null; sourcePostId?: string | null; project?: Proposal | null };
export type Album = { id: string; name: string; collection?: 'branding' | 'generic' | 'project' };
export type ReviewedPhoto = Photo & { origins: Set<string>; postIds: Set<string>; reportedAlbumIds: Set<string> };

const displayText = (value: string) => value.replace(/https?:\/\/\S+|\bBearer\s+\S+|\bEAA[A-Za-z0-9]{10,}|(?:access_token|appsecret_proof|client_secret)\s*=\s*[^&\s]+/gi, '[redacted]');
const projectRecord = (p?: Proposal | null) => p ? {
  name: displayText(p.name), reason: p.reason, action: p.action,
  destination: p.destination ? displayText(p.destination) : null,
  candidates: (p.candidates || []).map(t => ({ id: displayText(t.value), name: displayText(t.name), category: t.category, source: t.source })),
} : null;

function coverageSummary({ task, error, httpStatus, graphCode, timedOut }: CoverageError) {
  if (timedOut) return 'Request timed out';
  if (graphCode !== undefined) return 'Meta Graph API error';
  if (task === 'Preview request') return httpStatus ? `Preview request HTTP ${httpStatus}` : 'Preview request interrupted';
  if (httpStatus) return `Meta Graph HTTP ${httpStatus}`;
  if (task === 'Manual gallery inventory') return 'R2 listing failed';
  if (/pagination|\bcursor\b/i.test(error)) return 'Meta pagination could not be verified';
  if (/ownership/i.test(error)) return 'Photo ownership could not be verified';
  if (/no downloadable image|Facebook CDN URL/i.test(error)) return 'Photo image metadata is missing or unverified';
  return 'Coverage step failed';
}

export function buildReviewReport(input: {
  complete: boolean; draftChanged: boolean; phase: string; coverage: Coverage; warnings: string[]; errors: CoverageError[];
  albums: Map<string, Album>; posts: Set<string>; photos: Map<string, ReviewedPhoto>; byAlbum: Map<string, Map<string, Photo>>;
  mappings: Record<string, string>; duplicateKeys: (id: string) => string[]; needsDecision: (id: string, album: Album) => boolean;
}) {
  const albumIdsByPhoto = new Map<string, string[]>();
  const albums = [...input.albums.values()].map(album => {
    const members = [...(input.byAlbum.get(album.id)?.values() || [])];
    for (const p of members) {
      const ids = albumIdsByPhoto.get(p.id) || [];
      ids.push(album.id);
      albumIdsByPhoto.set(p.id, ids);
    }
    return {
      id: album.id, name: displayText(album.name), collection: album.collection,
      draftDestination: input.mappings[album.id] ? displayText(input.mappings[album.id]) : null,
      needsReview: input.needsDecision(album.id, album), discoveredPhotoCount: members.length,
      reviewedPhotoCount: members.filter(p => p.outcome).length,
      photos: members.map(p => ({ id: p.id, outcome: p.outcome || 'pending', proposedDestination: projectRecord(p.project) })),
    };
  });
  const photos = [...input.photos.values()].map(p => ({
    id: p.id, sources: [...p.origins], albumIds: albumIdsByPhoto.get(p.id) || [], reportedAlbumIds: [...p.reportedAlbumIds],
    postIds: [...p.postIds], outcome: p.outcome || 'pending', proposedDestination: projectRecord(p.project),
    possibleManualDuplicates: input.duplicateKeys(p.id).map(displayText),
  }));
  return {
    schemaVersion: 2, status: input.complete ? 'complete' : 'incomplete', complete: input.complete,
    phase: input.phase, mappingDraftChanged: input.draftChanged,
    coverage: input.coverage, warnings: input.warnings.map(displayText),
    coverageErrors: input.errors.map(error => ({
      task: /^(?:[0-9_]{1,64}\/(?:albums|photos|posts|attachments|subattachments|photo)|Preview request|Manual gallery inventory)$/.test(error.task) ? error.task : 'Preview',
      summary: coverageSummary(error), httpStatus: error.httpStatus, graphCode: error.graphCode,
      graphSubcode: error.graphSubcode, rayId: error.rayId,
    })),
    sourceCounts: {
      albums: albums.length, verifiedPosts: input.posts.size, uniquePhotos: photos.length,
      albumOnly: photos.filter(p => p.sources.includes('album') && !p.sources.includes('post')).length,
      postOnly: photos.filter(p => p.sources.includes('post') && !p.sources.includes('album')).length,
      albumsAndPosts: photos.filter(p => p.sources.includes('album') && p.sources.includes('post')).length,
      pendingReview: photos.filter(p => p.outcome === 'pending').length,
      alreadyImported: photos.filter(p => p.outcome === 'existing').length,
      suppressed: photos.filter(p => p.outcome === 'suppressed').length,
      excluded: photos.filter(p => p.outcome === 'excluded').length,
      possibleManualDuplicates: photos.filter(p => p.possibleManualDuplicates.length).length,
      albumsNeedingDecision: albums.filter(a => a.needsReview).length,
    },
    visualDuplicatesChecked: false, verifiedPostIds: [...input.posts], albums, photos,
  };
}

export const isRetryablePreviewStatus = (status?: number) => status === undefined || [500, 502, 503, 504].includes(status);
