// Copies non-TypeScript runtime assets (views, static files) into dist/.
import { cpSync } from 'node:fs';
cpSync('src/views', 'dist/views', { recursive: true });
cpSync('src/public', 'dist/public', { recursive: true });
console.log('Copied views and public assets to dist/');
