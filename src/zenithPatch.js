'use strict';
// 讓 Zenith 能在「沒開開發人員模式、也不是管理員」的 Windows 上建立專案。
//
// Zenith 建專案的最後一步，會在工作資料夾放四個給 host agent 找 skills 用的捷徑
// （.agents/skills、.claude/skills、.codex/skills、AGENTS.md），用的是 symlink。
// Windows 只有開發人員模式或管理員才能建 symlink，所以一般使用者一定會撞到
// [WinError 1314]，zenith_start_project 必失敗。
//
// 這裡把那幾個呼叫換成「先試 symlink，再退而求其次」：
//   ・資料夾 → NTFS junction（一般使用者就能建，行為跟 symlink 幾乎一樣）
//   ・檔案   → 硬連結（同磁碟才行），最後才複製一份
//
// 修改的是使用者本機的 Zenith 原始碼。每次要啟動 Zenith 前都會檢查一次，
// 所以使用者自己更新或重裝 Zenith 之後也會自動補回來。
const fs = require('fs');
const path = require('path');

const MARKER = '# --- codex-multi: windows-safe link shims ---';

const ANCHOR_LF = `# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------
`;

const HELPERS_LF = `
${MARKER}
# Windows refuses symlinks to non-elevated processes unless Developer Mode is
# on (WinError 1314). Junctions (directories) and hard links (files) need no
# such privilege, so prefer them as fallbacks before giving up and copying.


def _is_link_like(path: Path) -> bool:
    """True for symlinks and, on Windows, directory junctions."""
    try:
        if path.is_symlink():
            return True
    except OSError:
        return False
    isjunction = getattr(os.path, "isjunction", None)
    if isjunction is None:
        return False
    try:
        return bool(isjunction(path))
    except OSError:
        return False


def _remove_link(path: Path) -> None:
    """Remove a symlink or junction without touching what it points at."""
    try:
        path.unlink()
        return
    except OSError:
        pass
    try:
        os.rmdir(path)
    except OSError:
        pass


def _same_path(a: Path, b: Path) -> bool:
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _link_dir(link: Path, target: Path) -> None:
    """Point \`link\` at directory \`target\`; junction, then copy, as fallbacks."""
    if _is_link_like(link):
        if _same_path(link, target):
            return
        _remove_link(link)
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == "nt":
        try:
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
            return
        except (OSError, ImportError, AttributeError, ValueError):
            pass
    # Last resort: a real directory seeded with copies. Skills added to the
    # bucket later will not appear here until the surface is synced again.
    if target.is_dir() and not _same_path(link, target):
        shutil.copytree(target, link, dirs_exist_ok=True)
    else:
        link.mkdir(parents=True, exist_ok=True)


def _link_file(link: Path, target: Path) -> None:
    """Point \`link\` at file \`target\`; hard link, then copy, as fallbacks."""
    if os.path.lexists(link) and _same_path(link, target):
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(target)
        return
    except OSError:
        pass
    try:
        os.link(target, link)  # same volume only
        return
    except OSError:
        pass
    # Cross-volume (e.g. ZENITH_HOME on C:, workspace on E:): copy instead.
    if target.exists():
        shutil.copy2(target, link)


# --- end codex-multi shims ---
`;

const OLD_SKILLS_SURFACE_LF = `    def _ensure_skills_surface(self, link: Path, target: Path) -> None:
        """Expose aggregate bucket skills without replacing real repo skill dirs."""
        target_abs = target.resolve() if target.exists() else target
        if link.is_symlink():
            try:
                if not link.exists():
                    link.unlink()
                    link.symlink_to(target_abs)
                    return
                if link.resolve() == target_abs:
                    return
                return
            except OSError:
                return
        if link.exists():
            if link.is_dir():
                if self._is_bootstrap_skill_dir(link):
                    shutil.rmtree(link)
                    link.symlink_to(target_abs)
                    return
                self._copy_missing_tree(target_abs, link)
            return
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target_abs)
`;

const NEW_SKILLS_SURFACE_LF = `    def _ensure_skills_surface(self, link: Path, target: Path) -> None:
        """Expose aggregate bucket skills without replacing real repo skill dirs."""
        target_abs = target.resolve() if target.exists() else target
        if _is_link_like(link):
            try:
                if not link.exists():
                    _remove_link(link)
                    _link_dir(link, target_abs)
                return
            except OSError:
                return
        if link.exists():
            if link.is_dir():
                if self._is_bootstrap_skill_dir(link):
                    shutil.rmtree(link)
                    _link_dir(link, target_abs)
                    return
                self._copy_missing_tree(target_abs, link)
            return
        _link_dir(link, target_abs)
`;

const OLD_AGENTS_SURFACE_LF = `        target_abs = target.resolve() if target.exists() else target
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target_abs)
`;

const NEW_AGENTS_SURFACE_LF = `        target_abs = target.resolve() if target.exists() else target
        _link_file(link, target_abs)
`;

const OLD_COPY_TREE_LF = `            if src.is_symlink():
                dest.symlink_to(os.readlink(src))
`;

const NEW_COPY_TREE_LF = `            if src.is_symlink():
                try:
                    dest.symlink_to(os.readlink(src))
                except OSError:
                    resolved = Path(os.path.realpath(src))
                    if resolved.is_dir():
                        _link_dir(dest, resolved)
                    elif resolved.is_file():
                        shutil.copy2(resolved, dest)
`;

/** Zenith 專案資料夾裡放 ProjectStore 的檔案。 */
function storagePath(zenithRoot) {
  return path.join(zenithRoot, 'src', 'zenith_harness', 'storage.py');
}

/**
 * 需要時就地修正 storage.py。
 * 回傳 { status, path, reason }：
 *   already   已經修過（或不是 Windows，不需要修）
 *   patched   這次成功修好
 *   skipped   找不到檔案 / 對不上原始內容 / 寫不進去（都不算致命，照常啟動）
 */
function ensureWindowsLinks(zenithRoot, { force = false } = {}) {
  if (process.platform !== 'win32' && !force) return { status: 'already', reason: '非 Windows，不需要修正' };
  const file = storagePath(zenithRoot || '');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { status: 'skipped', path: file, reason: `讀不到 storage.py：${e.message}` };
  }
  if (src.includes(MARKER)) return { status: 'already', path: file };

  // Windows 上 git 會把 storage.py 簽出成 CRLF，比對前要先把樣板換成同一種換行
  const crlf = src.includes('\r\n');
  const nl = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
  const ANCHOR = nl(ANCHOR_LF);
  const HELPERS = nl(HELPERS_LF);
  const OLD_SKILLS_SURFACE = nl(OLD_SKILLS_SURFACE_LF);
  const NEW_SKILLS_SURFACE = nl(NEW_SKILLS_SURFACE_LF);
  const OLD_AGENTS_SURFACE = nl(OLD_AGENTS_SURFACE_LF);
  const NEW_AGENTS_SURFACE = nl(NEW_AGENTS_SURFACE_LF);
  const OLD_COPY_TREE = nl(OLD_COPY_TREE_LF);
  const NEW_COPY_TREE = nl(NEW_COPY_TREE_LF);

  const parts = [
    ['ANCHOR', ANCHOR],
    ['_ensure_skills_surface', OLD_SKILLS_SURFACE],
    ['_ensure_agents_surface', OLD_AGENTS_SURFACE],
    ['_copy_missing_tree', OLD_COPY_TREE],
  ];
  for (const [name, needle] of parts) {
    if (src.split(needle).length !== 2) {
      // Zenith 改版了，內容對不上就不要硬改——寧可讓它維持原樣並回報。
      return { status: 'skipped', path: file, reason: `Zenith 的 ${name} 與預期不符，未修改（可能是新版本）` };
    }
  }

  let out = src.replace(ANCHOR, ANCHOR + HELPERS);
  out = out.replace(OLD_SKILLS_SURFACE, NEW_SKILLS_SURFACE);
  out = out.replace(OLD_AGENTS_SURFACE, NEW_AGENTS_SURFACE);
  out = out.replace(OLD_COPY_TREE, NEW_COPY_TREE);

  try {
    const backup = `${file}.orig`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, src, 'utf8');
    fs.writeFileSync(file, out, 'utf8');
  } catch (e) {
    return { status: 'skipped', path: file, reason: `寫不進 storage.py：${e.message}` };
  }
  return { status: 'patched', path: file };
}

module.exports = { ensureWindowsLinks, storagePath, MARKER };
