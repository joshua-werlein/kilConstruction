import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewReport, isRetryablePreviewStatus } from '../src/utils/facebook-review-report.ts';

test('partial Facebook review exports pending photos, overlap, post-only IDs, and safe error details', () => {
  const proposal = { name: 'Ganz Garage', action: 'reuse', reason: 'album-match', destination: 'project:13' };
  const photo = (id, sources, postIds, outcome) => ({
    id, origins: new Set(sources), postIds: new Set(postIds), reportedAlbumIds: new Set(),
    outcome, project: outcome ? proposal : null, caption: 'SECRET_CAPTION',
  });
  const shared = photo('901', ['album', 'post'], ['10_1'], 'existing');
  const pending = photo('902', ['album'], [], undefined);
  const postOnly = photo('903', ['post'], ['10_2'], 'new');
  const output = buildReviewReport({
    complete: false, draftChanged: false, phase: 'facebook',
    coverage: { albumPages: 1, postPages: 1, postsReturned: 2, postsUnknownAuthor: 0, postsOtherAuthor: 0 },
    warnings: ['Problem near https://graph.facebook.com/path?appsecret_proof=SECRET_URL'],
    errors: [{ task: '903/photo', httpStatus: 503, graphCode: 2, error: 'SECRET_GRAPH_BODY' }],
    albums: new Map([['51', { id: '51', name: 'Ganz', collection: 'project' }], ['52', { id: '52', name: 'Empty album' }]]),
    posts: new Set(['10_1', '10_2']), photos: new Map([shared, pending, postOnly].map(p => [p.id, p])),
    byAlbum: new Map([['51', new Map([[shared.id, shared], [pending.id, pending]])]]),
    mappings: { 51: 'project:13' }, duplicateKeys: id => id === '901' ? ['Projects/Ganz Garage/901.jpg'] : [],
    needsDecision: () => false, state: { cursor: 'SECRET_CURSOR' }, authorization: 'SECRET_TOKEN',
  });
  assert.equal(output.status, 'incomplete');
  assert.equal(output.sourceCounts.uniquePhotos, 3);
  assert.equal(output.sourceCounts.albumsAndPosts, 1);
  assert.equal(output.sourceCounts.postOnly, 1);
  assert.equal(output.sourceCounts.pendingReview, 1);
  assert.equal(output.albums[0].discoveredPhotoCount, 2);
  assert.equal(output.albums[0].reviewedPhotoCount, 1);
  assert.equal(output.albums[1].discoveredPhotoCount, 0);
  assert.deepEqual(output.photos[2].postIds, ['10_2']);
  assert.deepEqual(output.photos[2].albumIds, []);
  assert.equal(output.photos[2].proposedDestination.destination, 'project:13');
  assert.equal(output.coverageErrors[0].httpStatus, 503);
  assert.equal(output.coverageErrors[0].graphCode, 2);
  assert.doesNotMatch(JSON.stringify(output), /SECRET_|graph\.facebook\.com/);
});

test('preview retries transport and gateway failures but stops for authentication or validation errors', () => {
  for (const status of [undefined, 500, 502, 503, 504]) assert.equal(isRetryablePreviewStatus(status), true);
  for (const status of [400, 401, 403, 429]) assert.equal(isRetryablePreviewStatus(status), false);
});
