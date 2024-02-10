import type { AstroConfig, RouteData, RoutePart } from 'astro';

import { writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import glob from 'tiny-glob';
import { removeLeadingForwardSlash, removeTrailingForwardSlash } from './assets.js';

/**
 * create _routes.json automatically
 * two approaches:
 * include everything and exclude static
 * if 404 is not prerendered, we need to include everything
 * include only ssr paths
 * we want to use as much wildcards as possible
 * assetsURL should be excluded via wildcard
 * _workers.js dir should not be in the routes anyway (cause it is the server bundle)
 * we would work based on routes (endpoint / page)
 * static files should be based on src rather than dist
 * static files should not include cloudflare special files
 * we need forwardslash
 * we need to add the base path
 * redirects from _redirects should be excluded
 */

export const getParts = (part: string) => {
	const result: RoutePart[] = [];
	part.split(/\[(.+?\(.+?\)|.+?)\]/).map((str, i) => {
		if (!str) return;
		const dynamic = i % 2 === 1;

		const [, content] = dynamic ? /([^(]+)$/.exec(str) || [null, null] : [null, str];

		if (!content || (dynamic && !/^(?:\.\.\.)?[\w$]+$/.test(content))) {
			throw new Error('Parameter name must match /^[a-zA-Z0-9_$]+$/');
		}

		result.push({
			content,
			dynamic,
			spread: dynamic && /^\.{3}.+$/.test(content),
		});
	});

	return result;
};

const segmentsToCfSyntax = (segments: RouteData['segments'], _config: AstroConfig) => {
	if (segments.length === 0) return ['', ''];
	const pathSegments = [removeLeadingForwardSlash(removeTrailingForwardSlash(_config.base))];
	for (const segment of segments.flat()) {
		if (segment.dynamic) pathSegments.push('*');
		else pathSegments.push(segment.content);
	}
	return pathSegments;
};

const deduplicateInPlace = (element: string[], index: number, paths: string[][]) => {
	const regexp = new RegExp(`${element.join('/').replace(/(\*\/)*\*$/g, '[*\\w\\/]+')}$`, 'gm');
	for (let i = index + 1; i < paths.length; i++) {
		if (regexp.test(paths[i].join('/'))) {
			paths.splice(i, 1);
			i--;
		}
	}
};

const sort = (first: string[], second: string[]) => {
	// more segements should be sorted first
	if (second.length > first.length) return -1;
	if (first.length > second.length) return 1;

	// equal amount of segments, sort by specifity
	for (let i = 0; i < first.length; i++) {
		// if segment is equal, continue with next segment
		if (first[i] === second[i]) continue;
		// wildcard segments should be sorted last
		if (first[i] === '*' && second[i] !== '*') return -1;
		if (first[i] !== '*' && second[i] === '*') return 1;
	}

	return 0;
};

export default async function (
	_config: AstroConfig,
	routes: RouteData[],
	pages: {
		pathname: string;
	}[],
	redirects: RoutePart[][][]
) {
	const includePaths: string[][] = [];
	const excludePaths: string[][] = [];

	let hasPrerendered404 = false;
	for (const route of routes) {
		const convertedPath = segmentsToCfSyntax(route.segments, _config);
		if (route.pathname === '/404' && route.prerender === true) hasPrerendered404 = true;

		if (route.type === 'page') if (route.prerender === false) includePaths.push(convertedPath);

		if (route.type === 'endpoint')
			if (route.prerender === false) includePaths.push(convertedPath);
			else excludePaths.push(convertedPath);

		if (route.type === 'redirect') excludePaths.push(convertedPath);
	}

	for (const page of pages) {
		const pageSegments = removeLeadingForwardSlash(page.pathname)
			.split(posix.sep)
			.filter(Boolean)
			.map((s) => {
				return getParts(s);
			});
		excludePaths.push(segmentsToCfSyntax(pageSegments, _config));
	}

	const staticFiles = await glob(`${fileURLToPath(_config.publicDir)}/**/*`, {
		cwd: fileURLToPath(_config.publicDir),
		filesOnly: true,
		dot: true,
	});
	for (const staticFile of staticFiles) {
		if (['_headers', '_redirects', '_routes.json'].includes(staticFile)) continue;
		const staticPath = staticFile;

		const segments = removeLeadingForwardSlash(staticPath)
			.split(posix.sep)
			.filter(Boolean)
			.map((s: string) => {
				return getParts(s);
			});
		excludePaths.push(segmentsToCfSyntax(segments, _config));
	}

	const assetsPath = segmentsToCfSyntax(
		[
			[{ content: _config.build.assetsPrefix ?? '_astro', dynamic: false, spread: false }],
			[{ content: '', dynamic: true, spread: false }],
		],
		_config
	);
	excludePaths.push(assetsPath);

	for (const redirect of redirects) {
		excludePaths.push(segmentsToCfSyntax(redirect, _config));
	}

	includePaths.sort(sort);
	excludePaths.sort(sort);

	console.log(includePaths);
	console.log('---');
	console.log(excludePaths);

	for (const [index, element] of includePaths.entries()) {
		deduplicateInPlace(element, index, includePaths);
	}

	for (const [index, element] of excludePaths.entries()) {
		console.log(element);
		deduplicateInPlace(element, index, excludePaths);
	}

	console.log('------');
	console.log(includePaths);
	console.log('---');
	console.log(excludePaths);

	console.log('------');
	console.log('INCLUDE', includePaths.length);
	console.log('---');
	console.log('EXCLUDE', excludePaths.length);

	if (
		!hasPrerendered404 ||
		includePaths.length > 100 ||
		includePaths.length > excludePaths.length
	) {
		try {
			await writeFile(
				new URL('./_routes.json', _config.outDir),
				JSON.stringify(
					{
						version: 1,
						include: ['/*'],
						exclude: excludePaths.map((path) => path.join('/')).slice(0, 99),
					},
					null,
					2
				),
				'utf-8'
			);
		} catch (error) {
			// TODO
		}
	} else if (includePaths.length < excludePaths.length) {
		try {
			await writeFile(
				new URL('./_routes.json', _config.outDir),
				JSON.stringify(
					{
						version: 1,
						include: includePaths.map((path) => path.join('/')),
						exclude: []
					},
					null,
					2
				),
				'utf-8'
			);
		} catch (error) {
			// TODO
		}
	} else {
		// TODO
	}
}
