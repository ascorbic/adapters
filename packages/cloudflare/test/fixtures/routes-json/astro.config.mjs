import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
	adapter: cloudflare(),
	output: 'server',
	build: {
		inlineStylesheets: 'never',
	},
	redirects: {
		'/user/astro': '/u/astro',
	},
});
