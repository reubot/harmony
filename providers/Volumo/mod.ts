// import { availableRegions } from './regions.ts';
import { type CacheEntry, MetadataApiProvider, type ProviderOptions, ReleaseApiLookup } from '@/providers/base.ts';
import { DurationPrecision, FeatureQuality, FeatureQualityMap } from '@/providers/features.ts';
import { capitalizeReleaseType } from '@/harmonizer/release_types.ts';
import { parseHyphenatedDate, PartialDate, parseISODateTime } from '@/utils/date.ts';
import { splitLabels } from '@/utils/label.ts';
import { ProviderError, ResponseError } from '@/utils/errors.ts';
import { formatGtin, isEqualGTIN } from '@/utils/gtin.ts';
import { extractTextFromHtml } from '@/utils/html.ts';

import type { ApiError, MinimalArtist, Release, ReleaseTrack, Result, Track, TracklistItem } from './api_types.ts';

import type {
	ArtistCreditName,
	EntityId,
	HarmonyMedium,
	HarmonyRelease,
	HarmonyTrack,
	LinkType,
	ReleaseGroupType,
	ReleaseOptions,
	ReleaseSpecifier,
} from '@/harmonizer/types.ts';

// See https://developers.volumo.com/api

export default class VolumoProvider extends MetadataApiProvider {
	constructor(options: ProviderOptions = {}) {
		super({
			rateLimitInterval: 5000,
			concurrentRequests: 50,
			...options,
		});
	}

	readonly name = 'Volumo';

	readonly supportedUrls = new URLPattern({
		hostname: '{www.}?volumo.com',
		pathname: String.raw`/:language(\w{2})?/:type(album|artist|track)/:id(\d+)`,
	});

	override readonly features: FeatureQualityMap = {
		'cover size': 3000,
		'duration precision': DurationPrecision.MS,
		'GTIN lookup': FeatureQuality.GOOD,
		'MBID resolving': FeatureQuality.GOOD,
	};

	readonly entityTypeMap = {
		artist: 'artist',
		release: 'album',
	};

//	override readonly availableRegions = new Set(availableRegions);

	readonly releaseLookup = VolumoReleaseLookup;

	override readonly launchDate: PartialDate = {
		year: 2022,
		// month: 8,
		// day: 22,
	};

	readonly apiBaseUrl = 'https://volumo.com/api/v1';

	constructUrl(entity: EntityId): URL {
		return new URL([entity.type, entity.id].join('/'), 'https://volumo.com');
	}

	override getLinkTypesForEntity(): LinkType[] {
		return ['paid download'];
	}

	async query<Data>(apiUrl: URL, maxTimestamp?: number): Promise<CacheEntry<Data>> {
		const cacheEntry = await this.fetchJSON<Data>(apiUrl, {
			policy: { maxTimestamp },
		});
		const { error } = cacheEntry.content as { error?: ApiError };

		if (error) {
			throw new VolumoResponseError(error, apiUrl);
		}
		return cacheEntry;
	}


}

export class VolumoReleaseLookup extends ReleaseApiLookup<VolumoProvider, Release> {
	constructor(provider: VolumoProvider, specifier: ReleaseSpecifier, options: ReleaseOptions = {}) {
		super(provider, specifier, options);
/*
		if (this.lookup.method === 'gtin') {
			// Volumo API only returns a result for a truncated GTIN with 12 digits (UPC) at least.
			this.lookup.value = formatGtin(this.lookup.value, 12);
		}*/
	}

	constructReleaseApiUrl(): URL {
		if (this.lookup.method === 'gtin') {
			return new URL(`v1/album_by_icpn/${this.lookup.value}`, this.provider.apiBaseUrl);
		} else { // if (this.lookup.method === 'id')
			return new URL(`v1/albums/${this.lookup.value}`, this.provider.apiBaseUrl);
		}
	}

	protected async getRawRelease(): Promise<Release> {
		const apiUrl = this.constructReleaseApiUrl();
		const { content: release, timestamp } = await this.provider.query<Release>(
			apiUrl,
			this.options.snapshotMaxTimestamp,
		);
		this.updateCacheTime(timestamp);

		return release;
	}

	private async getRawTracklist(albumId: string): Promise<TracklistItem[]> {
		const tracklist: TracklistItem[] = [];
		let nextPageQuery: string | undefined = `album/${albumId}/tracks`;

		while (nextPageQuery) {
			const { content, timestamp }: CacheEntry<Result<TracklistItem>> = await this.provider.query(
				new URL(nextPageQuery, this.provider.apiBaseUrl),
				this.options.snapshotMaxTimestamp,
			);
			tracklist.push(...content.data);
			nextPageQuery = content.next;
			this.updateCacheTime(timestamp);
		}

		return tracklist;
	}

	protected async getRawTrackById(trackId: string): Promise<Track> {
		const { content: track, timestamp } = await this.provider.query<Track>(
			new URL(`track/${trackId}`, this.provider.apiBaseUrl),
			this.options.snapshotMaxTimestamp,
		);
		this.updateCacheTime(timestamp);
		return track;
	}

	protected async convertRawRelease(rawRelease: Release): Promise<HarmonyRelease> {
		// console.log(rawRelease);
		if (this.lookup.method === 'id') {
			rawRelease = rawRelease[0];
		}
		this.entity = {
			id: rawRelease.id.toString(),
			type: 'album',
		};

		if (this.lookup.method === 'id' && this.entity.id !== this.lookup.value) {
			throw new ProviderError(
				this.provider.name,
				`API returned ${rawRelease.link} instead of the requested ${
					this.provider.constructUrl({ id: this.lookup.value, type: 'album' })
				}`,
			);
		} else if (this.lookup.method === 'gtin' && !isEqualGTIN(rawRelease.icpn, this.lookup.value)) {
			throw new ProviderError(
				this.provider.name,
				`API returned a release with GTIN ${rawRelease.icpn} instead of the requested ${this.lookup.value}`,
			);
		}
		const externalLink = this.provider.constructUrl({ id: this.lookup.value, type: 'album' })

		const incompleteTracklist = rawRelease.tracks_total > rawRelease.tracks.length;
		console.log(incompleteTracklist, rawRelease.tracks_total + " " +  rawRelease.tracks.length);
		const needToFetchIndividualTracks = /*this.options.withAllTrackArtists || this.options.withAvailability ||*/ false;
		const needToFetchDetailedTracklist = false;/*incompleteTracklist ||
			(!needToFetchIndividualTracks && (this.options.withSeparateMedia || this.options.withISRC || false));*/

		let rawTracklist: Array<ReleaseTrack | TracklistItem | Track>;
		let media: HarmonyMedium[];

		if (needToFetchDetailedTracklist) {
			rawTracklist = await this.getRawTracklist(this.entity.id);
		} else {
			rawTracklist = rawRelease.tracks;
		}

		if (needToFetchIndividualTracks) {
			// replace minimal tracklist with all available details for each track
			rawTracklist = await Promise.all(rawTracklist.map((track) => this.getRawTrackById(track.id.toString())));
		}

		if (needToFetchDetailedTracklist || needToFetchIndividualTracks) {
			// we have enough info to split the tracklist into multiple media
			media = this.convertRawTracklist(rawTracklist as Array<TracklistItem | Track>);
		} else {
			media = [{
				format: 'Digital Media',
				tracklist: rawTracklist.map(this.convertRawTrack.bind(this)),
			}];
		}

		const fallbackCoverUrl = new URL(`album/${this.entity.id}/image`, this.provider.apiBaseUrl);
		const coverFull =new URL(`img/size/0x0/${rawRelease.artwork_uuid}.png`, 'https://volumo.com');
		const coverThumb =new URL(`img/size/200x0/${rawRelease.artwork_uuid}.png`, 'https://volumo.com');
		// console.debug(coverFull);
		return {
			title: rawRelease.title,
			artists: rawRelease.artists.map(this.convertRawArtist.bind(this)),
			gtin: rawRelease.icpn,
			externalLinks: [{
				url: externalLink, //rawRelease.link,
				types: this.provider.getLinkTypesForEntity(),
			}],
			media,
			releaseDate: parseISODateTime(rawRelease.release_start_at),
			//parseHyphenatedDate(rawRelease.original_release_date),
			labels: [{
				name: rawRelease.recordlabel.name,
				catalogNumber: rawRelease.catalog_number,
				externalIds: this.provider.makeExternalIds({
					type: 'label',
					id: rawRelease.recordlabel.id.toString(),
					// slug: rawRelease.label.slug,
				}),
			}],			status: 'Official',
			// types: [this.convertReleaseType(rawRelease.record_type)],
			packaging: 'None',
			images: [{
				url: coverFull.href /*?? fallbackCoverUrl.href*/ ,
				thumbUrl: coverThumb.href/* ?? fallbackCoverUrl.href*/ ,
				types: ['front'],
			 }],
			availableIn: this.determineAvailability(media),
			info: this.generateReleaseInfo(),
		};
	}

	private convertRawTracklist(tracklist: Array<TracklistItem | Track>): HarmonyMedium[] {
		const result: HarmonyMedium[] = [];
		let medium: HarmonyMedium = {
			tracklist: [],
		};

		// split flat tracklist into media
		tracklist.forEach((item, index) => {
			// store the previous medium and create a new one
			if (item.disk_number !== medium.number) {
				if (medium.number) {
					result.push(medium);
				}

				medium = {
					number: item.disk_number,
					format: 'Digital Media',
					tracklist: [],
				};
			}

			medium.tracklist.push(this.convertRawTrack(item, index));
		});

		// store the final medium
		result.push(medium);

		return result;
	}

	private convertRawTrack(track: ReleaseTrack | TracklistItem | Track, index: number): HarmonyTrack {
		
		const result: HarmonyTrack = {
			number: index + 1,
			title: track.title,
			length: track.duration/* * 1000*/,
			recording: {
				externalIds: this.provider.makeExternalIds({ type: 'track', id: track.id.toString() }),
			},
		};
		if ('version' in track && track.version != null) {
			result.title += ` (${track.version})`;
		}

		if ('isrc' in track) {
			// this is a detailed tracklist item
			result.isrc = track.isrc;
		}

		if ('artists' in track) {
			// all available details about this track have been fetched
			result.artists = track.artists.map(this.convertRawArtist.bind(this));
			result.availableIn = track.available_countries;
		} else {
			result.artists = [this.convertRawArtist(track.artist)];
		}
		if ('featured_artists' in track) {
			// all available details about this track have been fetched
			let featArtists = track.featured_artists.map(this.convertRawArtist.bind(this))
			/*featArtists[0]*/result.artists.at(-1).joinPhrase = " featuring ";
			result.artists = result.artists.concat(featArtists);
			result.availableIn = track.available_countries;
		}
		return result;
	}

	private convertRawArtist(artist: MinimalArtist): ArtistCreditName {
		console.log(artist);
		return {
			name: artist.name,
			creditedName: artist.name,
			externalIds: this.provider.makeExternalIds({ type: 'artist', id: artist.id.toString() }),
		};
	}

	private convertReleaseType(sourceType: string): ReleaseGroupType {
		return capitalizeReleaseType(sourceType.replace('COMPILE', 'COMPILATION'));
	}

	private determineAvailability(media: HarmonyMedium[]): string[] | undefined {
		const tracks = media.flatMap((medium) => medium.tracklist);
		const lastTrack = tracks.pop();

		// Calculate the intersection of all tracks' availabilities with Volumo's availability.
		// Iterate over any of the usually smaller sets of track regions (here: last track) instead of Volumo's full set.
		const otherTrackAvailabilities = tracks.map((track) => new Set(track.availableIn));
		return lastTrack?.availableIn?.filter((region) =>
			otherTrackAvailabilities.every((availability) => availability.has(region)) &&
			this.provider.availableRegions.has(region)
		);
	}
}

class VolumoResponseError extends ResponseError {
	constructor(readonly details: ApiError, url: URL) {
		super('Volumo', `${details.message} (code ${details.code})`, url);
	}
}
