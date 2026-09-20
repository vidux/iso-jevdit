/**
 * What counts as auditable source, and which language each file speaks. Language ids drive both the
 * chunker's boundary heuristics and a check's `languages` filter.
 */

export const EXTENSION_LANGUAGES: Record<string, string> = {
  '.php': 'php',
  '.phtml': 'php',
  '.blade.php': 'php',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.rb': 'ruby',
  '.erb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.m': 'objc',
  '.mm': 'objc',
  '.swift': 'swift',
  '.pl': 'perl',
  '.pm': 'perl',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sql': 'sql',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.jsonc': 'json',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'conf',
  '.env.example': 'dotenv',
  '.env.sample': 'dotenv',
  '.env.template': 'dotenv',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.hcl': 'hcl',
  '.xml': 'xml',
  '.gradle': 'gradle',
  '.cmake': 'cmake',
  '.tpl': 'template',
  '.twig': 'template',
  '.ejs': 'template',
  '.hbs': 'template',
};

/** Bare filenames that are auditable whatever their extension. */
export const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'docker',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  'compose.yml': 'yaml',
  makefile: 'make',
  'cmakelists.txt': 'cmake',
  '.htaccess': 'apacheconf',
  'nginx.conf': 'nginxconf',
  'web.config': 'xml',
  'procfile': 'conf',
};

/**
 * Languages where executable logic lives. Checks about code constructs (injection, crypto calls)
 * restrict themselves to these, so config and markup files are not asked about them.
 */
export const CODE_LANGUAGES: readonly string[] = Object.freeze([
  'php',
  'javascript',
  'typescript',
  'vue',
  'svelte',
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'kotlin',
  'scala',
  'csharp',
  'c',
  'cpp',
  'objc',
  'swift',
  'perl',
  'shell',
  'powershell',
  'template',
]);

export const DEFAULT_EXTENSIONS: readonly string[] = Object.freeze(Object.keys(EXTENSION_LANGUAGES));
export const DEFAULT_FILENAMES: readonly string[] = Object.freeze([
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'Makefile',
  'CMakeLists.txt',
  '.htaccess',
  'nginx.conf',
  'web.config',
  'Procfile',
]);

/** Skipped whatever .gitignore says, unless `ignoreDefaults` is false. `.git` is never scanned. */
export const DEFAULT_IGNORE_DIRS: readonly string[] = Object.freeze([
  'node_modules',
  'vendor',
  'bower_components',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.terraform',
  '.gradle',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.turbo',
  '.parcel-cache',
]);

export const DEFAULT_IGNORE_GLOBS: readonly string[] = Object.freeze([
  '**/*.min.js',
  '**/*.min.css',
  '**/*.min.mjs',
  '**/*.map',
  '**/*.snap',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/go.sum',
]);

/** Dot-directories worth auditing: CI and container config is evidence for A.8.25 and A.8.9. */
export const DEFAULT_INCLUDE_DOT_DIRS: readonly string[] = Object.freeze([
  '.github',
  '.gitlab',
  '.circleci',
  '.docker',
]);

/** Never scannable, no matter how the config is set. */
export const ALWAYS_SKIP_DIRS: readonly string[] = Object.freeze(['.git']);

const EXTENSIONS_BY_LENGTH = Object.keys(EXTENSION_LANGUAGES).sort((a, b) => b.length - a.length);

export interface EligibilityOptions {
  extensions: readonly string[];
  filenames: readonly string[];
}

/**
 * Longest suffix wins, so `.blade.php` beats `.php`. An exact match counts too: `.env.example` is a
 * real filename, not just a suffix, and it is one of the files most worth auditing.
 */
export function matchedExtension(basename: string, extensions: readonly string[]): string | undefined {
  const lower = basename.toLowerCase();
  const sorted = extensions === DEFAULT_EXTENSIONS ? EXTENSIONS_BY_LENGTH : [...extensions].sort((a, b) => b.length - a.length);
  return sorted.find((ext) => lower.endsWith(ext.toLowerCase()));
}

export function isEligibleFile(basename: string, opts: EligibilityOptions): boolean {
  const lower = basename.toLowerCase();
  if (opts.filenames.some((name) => name.toLowerCase() === lower)) return true;
  return matchedExtension(basename, opts.extensions) !== undefined;
}

export function languageFor(basename: string): string {
  const lower = basename.toLowerCase();
  const byName = FILENAME_LANGUAGES[lower];
  if (byName) return byName;
  const ext = matchedExtension(basename, DEFAULT_EXTENSIONS);
  return (ext && EXTENSION_LANGUAGES[ext]) || 'text';
}
