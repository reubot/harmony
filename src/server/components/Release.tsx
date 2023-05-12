import { ArtistCredit } from './ArtistCredit.tsx';
import { CoverImage } from './CoverImage.tsx';
import { Tracklist } from './Tracklist.tsx';
import { determineReleaseEventCountries } from '../../MusicBrainz/releaseCountries.ts';
import { formatPartialDate } from '../../utils/date.ts';
import { pluralWithCount } from '../../utils/plural.ts';
import { flagEmoji, regionName } from '../../utils/regions.ts';

import type { HarmonyRelease } from '../../harmonizer/types.ts';

const scriptNames = new Intl.DisplayNames('en', {
	type: 'script',
});

export function Release(release: HarmonyRelease) {
	const regions = release.availableIn;
	const excludedRegions = release.excludedFrom;
	const releaseCountries = determineReleaseEventCountries(release);
	const isMultiMedium = release.media.length > 1;
	const mainScript = release.mainScript;

	return (
		<div class='release'>
			<h2>{release.title}</h2>
			<p>
				by <ArtistCredit artists={release.artists} />
			</p>
			<table>
				<tr>
					<th>Release date</th>
					<td>{formatPartialDate(release.releaseDate) || '????'}</td>
				</tr>
				<tr>
					<th>Labels</th>
					<td>
						<ul>
							{release.labels?.map((label) => (
								<li>
									<a href={label.externalLink?.href}>{label.name}</a>
									{label.catalogNumber}
								</li>
							))}
						</ul>
					</td>
				</tr>
				<tr>
					<th>
						<abbr title='Global Trade Item Number'>GTIN</abbr>
					</th>
					<td>{release.gtin}</td>
				</tr>
				<tr>
					<th>External links</th>
					<td>
						<ul>
							{release.externalLinks.map((link) => (
								<li>
									<a href={link.url.href}>{link.url.hostname}</a>
									{link.types && ` (${link.types.join(', ')})`}
								</li>
							))}
						</ul>
					</td>
				</tr>
				{regions && (
					<tr>
						<th>Availability</th>
						<td>
							{regions.map((code) => (
								<>
									<abbr title={regionName(code)}>{flagEmoji(code)}</abbr>
									{' '}
								</>
							))}
							({pluralWithCount(regions.length, 'region')})
						</td>
					</tr>
				)}
				{excludedRegions && (
					<tr>
						<th>Unavailability</th>
						<td>
							{excludedRegions.map((code) => (
								<>
									<abbr title={regionName(code)}>{flagEmoji(code)}</abbr>
									{' '}
								</>
							))}
							({pluralWithCount(excludedRegions.length, 'region')})
						</td>
					</tr>
				)}
				{releaseCountries && (
					<tr>
						<th>Release events</th>
						<td>
							<ul>
								{releaseCountries.map((code) => (
									<li>
										{flagEmoji(code)} {regionName(code)}
									</li>
								))}
							</ul>
						</td>
					</tr>
				)}
				{mainScript && (
					<tr>
						<th>Script</th>
						<td>{scriptNames.of(mainScript.script)} ({(100 * mainScript.frequency).toFixed(1)}%)</td>
					</tr>
				)}
			</table>
			{release.images?.map((artwork) => <CoverImage artwork={artwork} />)}
			{release.media.map((medium) => <Tracklist medium={medium} showTitle={isMultiMedium} />)}
		</div>
	);
}