import type { AstroConfig, AstroIntegration, RouteData, RoutePart } from 'astro';
import type { LocalPagesRuntime, RUNTIME } from './utils/local-runtime.js';

import { createReadStream } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { AstroError } from 'astro/errors';
import { removeLeadingForwardSlash } from './utils/assets.js';
import createRoutesFile, { getParts } from './utils/generate-routes.js';
import { setImageConfig } from './utils/image-config.js';
import { getLocalRuntime, getRuntimeConfig } from './utils/local-runtime.js';
import { wasmModuleLoader } from './utils/wasm-module-loader.js';
import { createRedirectsFromAstroRoutes } from '@astrojs/underscore-redirects';

export type { AdvancedRuntime } from './entrypoints/server.advanced.js';

export type Options = {
	imageService?: 'passthrough' | 'cloudflare' | 'compile';
	wasmModuleImports?: boolean;
	/**
	 * { mode: 'off' }: current behaviour (wrangler is needed)
	 * { mode: 'local', ... }: adds cf request object, locals bindings, env vars/secrets which are defined by the user to `astro.dev` with `Astro.locals.runtime` / `context.locals.runtime`
	 */
	runtime?:
		| { mode: 'off' }
		| {
				mode: Extract<RUNTIME, { type: 'pages' }>['mode'];
				type: Extract<RUNTIME, { type: 'pages' }>['type'];
				persistTo?: Extract<RUNTIME, { type: 'pages' }>['persistTo'];
				bindings?: Extract<RUNTIME, { type: 'pages' }>['bindings'];
		  }
		| {
				mode: Extract<RUNTIME, { type: 'workers' }>['mode'];
				type: Extract<RUNTIME, { type: 'workers' }>['type'];
				persistTo?: Extract<RUNTIME, { type: 'workers' }>['persistTo'];
		  };
};

export default function createIntegration(args?: Options): AstroIntegration {
	let _config: AstroConfig;

	let _localRuntime: LocalPagesRuntime;
	const runtimeMode = getRuntimeConfig(args?.runtime);

	return {
		name: '@astrojs/cloudflare',
		hooks: {
			'astro:config:setup': ({ command, config, updateConfig, logger }) => {
				updateConfig({
					build: {
						client: new URL(`.${config.base}/`, config.outDir),
						server: new URL('./_worker.js/', config.outDir),
						serverEntry: 'index.js',
					},
					vite: {
						// load .wasm files as WebAssembly modules
						plugins: [
							wasmModuleLoader({
								disabled: !args?.wasmModuleImports,
								assetsDirectory: config.build.assets,
							}),
						],
					},
					image: setImageConfig(args?.imageService ?? 'DEFAULT', config.image, command, logger),
				});
			},
			'astro:config:done': ({ setAdapter, config }) => {
				_config = config;

				if (config.output === 'static') {
					throw new AstroError(
						'[@astrojs/cloudflare] `output: "server"` or `output: "hybrid"` is required to use this adapter. Otherwise, this adapter is not necessary to deploy a static site to Cloudflare.'
					);
				}

				setAdapter({
					name: '@astrojs/cloudflare',
					serverEntrypoint: '@astrojs/cloudflare/entrypoints/server.advanced.js',
					exports: ['default'],
					adapterFeatures: {
						functionPerRoute: false,
						edgeMiddleware: false,
					},
					supportedAstroFeatures: {
						serverOutput: 'stable',
						hybridOutput: 'stable',
						staticOutput: 'unsupported',
						i18nDomains: 'experimental',
						assets: {
							supportKind: 'stable',
							isSharpCompatible: false,
							isSquooshCompatible: false,
						},
					},
				});
			},
			'astro:server:setup': ({ server, logger }) => {
				if (runtimeMode.mode === 'local') {
					server.middlewares.use(async function middleware(req, res, next) {
						_localRuntime = getLocalRuntime(_config, runtimeMode, logger);

						const bindings = await _localRuntime.getBindings();
						const secrets = await _localRuntime.getSecrets();
						const caches = await _localRuntime.getCaches();
						const cf = await _localRuntime.getCF();

						const clientLocalsSymbol = Symbol.for('astro.locals');
						Reflect.set(req, clientLocalsSymbol, {
							runtime: {
								env: {
									CF_PAGES_URL: `http://${req.headers.host}`,
									...bindings,
									...secrets,
								},
								cf: cf,
								caches: caches,
								waitUntil: (_promise: Promise<any>) => {
									return;
								},
							},
						});
						next();
					});
				}
			},
			'astro:server:done': async ({ logger }) => {
				if (_localRuntime) {
					logger.info('Cleaning up the local Cloudflare runtime.');
					await _localRuntime.dispose();
				}
			},
			'astro:build:setup': ({ vite, target }) => {
				if (target === 'server') {
					vite.resolve ||= {};
					vite.resolve.alias ||= {};

					const aliases = [
						{
							find: 'react-dom/server',
							replacement: 'react-dom/server.browser',
						},
					];

					if (Array.isArray(vite.resolve.alias)) {
						vite.resolve.alias = [...vite.resolve.alias, ...aliases];
					} else {
						for (const alias of aliases) {
							(vite.resolve.alias as Record<string, string>)[alias.find] = alias.replacement;
						}
					}

					vite.ssr ||= {};
					vite.ssr.noExternal = true;
					vite.ssr.external = _config?.vite?.ssr?.external ?? [];
					vite.ssr.target = 'webworker';

					vite.build ||= {};
					vite.build.rollupOptions ||= {};
					vite.build.rollupOptions.external = [
						'node:assert',
						'node:async_hooks',
						'node:buffer',
						'node:crypto',
						'node:diagnostics_channel',
						'node:events',
						'node:path',
						'node:process',
						'node:stream',
						'node:string_decoder',
						'node:util',
						'cloudflare:*',
					];
				}
			},
			'astro:build:done': async ({ routes, pages, dir }) => {
				if (_config.base !== '/') {
					for (const file of ['_headers', '_redirects', '_routes.json']) {
						try {
							await rename(new URL(file, _config.build.client), new URL(file, _config.outDir));
						} catch (e) {
							/*  */
						}
					}
				}

				let redirectsExists = false;
				try {
					const redirectsStat = await stat(new URL('./_redirects', _config.outDir));
					if (redirectsStat.isFile()) {
						redirectsExists = true;
					}
				} catch (error) {
					redirectsExists = false;
				}

				const redirects: RoutePart[][][] = [];
				if (redirectsExists) {
					const rl = createInterface({
						input: createReadStream(new URL('./_redirects', _config.outDir)),
						crlfDelay: Infinity,
					});

					for await (const line of rl) {
						const parts = line.split(' ');
						if (parts.length >= 2) {
							const p = removeLeadingForwardSlash(parts[0])
								.split('/')
								.filter(Boolean)
								.map((s: string) => {
									const syntax = s
										.replace(/\/:.*?(?=\/|$)/g, '/*')
										// remove query params as they are not supported by cloudflare
										.replace(/\?.*$/, '');
									return getParts(syntax);
								});
							redirects.push(p);
						}
					}
				}

				let routesExists = false;
				try {
					const routesStat = await stat(new URL('./_routes.json', _config.outDir));
					if (routesStat.isFile()) {
						routesExists = true;
					}
				} catch (error) {
					routesExists = false;
				}

				if (!routesExists) {
					await createRoutesFile(_config, routes, pages, redirects);
				}

				const redirectRoutes: [RouteData, string][] = [];
				for (const route of routes) {
					if (route.type === 'redirect') redirectRoutes.push([route, '']);
				}

				const trueRedirects = createRedirectsFromAstroRoutes({
					config: _config,
					routeToDynamicTargetMap: new Map(Array.from(redirectRoutes)),
					dir,
				});

				if (!trueRedirects.empty()) {
					try {
						await appendFile(new URL('./_redirects', _config.outDir), trueRedirects.print());
					} catch (error) {
						// TODO
					}
				}
			},
		},
	};
}
