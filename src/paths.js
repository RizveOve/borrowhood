// Project root, found by looking for the views folder. Usually one level above src/, but inside a
// bundled serverless function the files may sit next to the working directory instead.
const fs = require('fs');
const path = require('path');

const candidates = [path.join(__dirname, '..'), process.cwd(), process.env.LAMBDA_TASK_ROOT].filter(Boolean);
const ROOT = candidates.find((dir) => fs.existsSync(path.join(dir, 'views'))) || candidates[0];

module.exports = { ROOT };
