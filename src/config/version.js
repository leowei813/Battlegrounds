import changelogMd from '../../CHANGELOG.md?raw';
import { parseChangelog } from '../utils/changelog.js';

/** 目前版本（建置時由 vite.config.js 從 package.json 注入） */
// eslint-disable-next-line no-undef
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';

/** 更新日誌（新版本在前） */
export const CHANGELOG = parseChangelog(changelogMd);
