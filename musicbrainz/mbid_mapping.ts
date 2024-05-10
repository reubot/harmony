import { ApiError, type EntityWithMbid } from '@kellnerd/musicbrainz';
import type { RelatableEntityType } from '@kellnerd/musicbrainz/data/entity';
import type { ExternalEntityId, HarmonyRelease, ResolvableEntity } from '@/harmonizer/types.ts';
import { MB } from '@/musicbrainz/api_client.ts';
import { providers } from '@/providers/mod.ts';
import { isDevServer } from '@/server/config.ts';

/**
 * Resolves external IDs for a MusicBrainz entity to its MBID.
 *
 * Tries to lookup each of the given external IDs until an MBID is found.
 * Before sending requests to the MusicBrainz API, the MBID cache is checked.
 *
 * Accepts an optional context cache which also stores unresolved external IDs.
 * This is useful to avoid multiple unsuccessful API requests for the same entity within a short interval.
 */
export async function resolveToMbid(
	entityIds: ExternalEntityId[],
	entityType: RelatableEntityType,
	contextCache?: Record<string, string>,
): Promise<string | undefined> {
	if (!entityIds.length) return;

	// First check the caches for each entity ID.
	const uncachedIds: ExternalEntityId[] = [];
	for (const entityId of entityIds) {
		const mbid = getCachedMbid(entityId, contextCache);
		if (mbid) {
			return mbid;
		} else if (mbid !== '') {
			// Empty MBID is used by the context cache to indicate that further requests should be skipped.
			uncachedIds.push(entityId);
		}
	}

	// If the MBID is not cached, try to lookup canonical entity URLs with the MB API.
	for (const entityId of uncachedIds) {
		const externalUrl = providers.constructEntityUrl(entityId);
		try {
			const result = await MB.browseUrl(externalUrl, {
				inc: [`${entityType}-rels`],
			});
			const rels = result.relations.filter((rel) => rel['target-type'] === entityType);
			if (rels.length !== 1) {
				// External URL can not be used as a unique identifier of one entity.
				if (contextCache) {
					// Only writes to the context cache to indicate that further requests for this URL should be skipped.
					setCachedMbid(entityId, '', contextCache);
				}
				continue;
			}

			const uniqueRel = rels[0];
			// @ts-ignore: `entityType` is not narrowed, but every specific value is a valid key here.
			const targetEntity = uniqueRel[entityType] as EntityWithMbid;
			const mbid = targetEntity.id;
			console.debug('Resolved', entityType, mbid, externalUrl.href);
			setCachedMbid(entityId, mbid, contextCache);

			return mbid;
		} catch (error) {
			if (error instanceof ApiError) {
				// Only writes to the context cache to indicate that further requests for this URL should be skipped.
				setCachedMbid(entityId, '', contextCache);
				console.debug('Resolving error for', externalUrl.href);
				continue;
			}
			throw error;
		}
	}
}

/** Resolves all external links for artists and labels of the given release to their MBIDs. */
export async function resolveReleaseMbids(release: HarmonyRelease) {
	const startTime = performance.now();
	const { artists, labels, media } = release;
	const contextCache = {};

	await resolveMbidsForMultipleEntities(artists, 'artist', contextCache);
	if (labels) {
		await resolveMbidsForMultipleEntities(labels, 'label', contextCache);
	}
	for (const medium of media) {
		for (const track of medium.tracklist) {
			if (track.artists) {
				await resolveMbidsForMultipleEntities(track.artists, 'artist', contextCache);
			}
		}
	}

	const elapsedTime = performance.now() - startTime;
	const requestCount = Object.keys(contextCache).length;
	release.info.messages.push({
		type: 'debug',
		text: `Resolving external IDs to MBIDs took ${elapsedTime.toFixed(0)} ms and ${requestCount} API requests`,
	});
}

async function resolveMbidForEntity(
	entity: ResolvableEntity,
	entityType: RelatableEntityType,
	contextCache?: Record<string, string>,
) {
	if (entity.mbid) return;
	if (entity.externalIds) {
		entity.mbid = await resolveToMbid(entity.externalIds, entityType, contextCache);
	}
}

function resolveMbidsForMultipleEntities(
	entities: ResolvableEntity[],
	entityType: RelatableEntityType,
	contextCache?: Record<string, string>,
) {
	return Promise.all(
		entities.map((entity) => resolveMbidForEntity(entity, entityType, contextCache)),
	);
}

// Use persistent local storage in development (watch mode) when the server frequently restarts.
const cache = isDevServer ? localStorage : sessionStorage;
const cacheKeySeparator = ':';
const mbidCachePrefix = 'mbid';

function getCachedMbid(entityId: ExternalEntityId, contextCache?: Record<string, string>): string | undefined {
	const key = [mbidCachePrefix, entityId.provider, entityId.type, entityId.id].join(cacheKeySeparator);
	return contextCache?.[key] ?? cache.getItem(key) ?? undefined;
}

function setCachedMbid(entityId: ExternalEntityId, mbid: string, contextCache?: Record<string, string>) {
	const key = [mbidCachePrefix, entityId.provider, entityId.type, entityId.id].join(cacheKeySeparator);
	if (contextCache) {
		contextCache[key] = mbid;
	}
	if (mbid !== '') {
		setCacheItem(key, mbid);
	}
}

function setCacheItem(key: string, value: string, retries = 1) {
	try {
		cache.setItem(key, value);
	} catch (error) {
		console.debug('Failed to cache item:', error);
		if (retries > 0) {
			deleteRandomCacheItem();
			deleteRandomCacheItem();
			setCacheItem(key, value, retries - 1);
		} else {
			console.warn(`Caching of '${key}' failed repeatedly`);
		}
	}
}

function deleteRandomCacheItem() {
	if (!cache.length) return;

	const randomIndex = Math.trunc(Math.random() * cache.length);
	const randomKey = cache.key(randomIndex);
	if (randomKey !== null) {
		cache.removeItem(randomKey);
	}
}
