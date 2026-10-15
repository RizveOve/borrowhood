// All page requests go to the BorrowHood Express app (static files in public/ are served by the CDN).
import borrowhood from '../../src/netlify.js';

export default (req) => borrowhood.handle(req);

export const config = { path: '/*', preferStatic: true };
