// All page requests go to the BorrowHood Express app (static files in public/ are served by the CDN).
// The app is CommonJS; loading it with createRequire keeps it out of the entry bundle so Netlify
// traces and packages its npm dependencies.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const borrowhood = require('../../src/netlify.js');

export default (req) => borrowhood.handle(req);

export const config = { path: '/*', preferStatic: true };
