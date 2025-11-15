import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface ImageRenamerSettings {
    mySetting: string;
}

const DEFAULT_SETTINGS: ImageRenamerSettings = {
    mySetting: 'default'
}

export default class ImageRenamerPlugin extends Plugin {
    settings: ImageRenamerSettings;

    async onload() {
        await this.loadSettings();

        // 注册编辑器右键菜单，检测光标所在是否为图片链接，若是则添加 AutoRename 项
        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor: Editor, view: MarkdownView) => {
            if (!view || !view.file) return;
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            const ch = cursor.ch;

            const patterns = [
                { regex: /\!\[\[(.+?)(\|.*?)*\]\]/g, kind: 'wiki' },      // ![[...]] 语法
                { regex: /\!\[.*?\]\((.+?)\)/g, kind: 'inline' }          // ![alt](path) 语法
            ];

            for (const p of patterns) {
                let m: RegExpExecArray | null;
                while ((m = p.regex.exec(line)) !== null) {
                    const start = m.index;
                    const end = p.regex.lastIndex;
                    if (start <= ch && ch <= end) {
                        const rawLink = m[1];
                        menu.addItem(item => item
                            .setTitle('AutoRename Image')
                            .setIcon('dice')
                            .onClick(async () => {
                                try {
                                    await this.autoRenameImage(view, editor, cursor.line, start, end, rawLink, p.kind, m[0]);
                                } catch (e) {
                                    new Notice('AutoRename failed: ' + (e?.message ?? String(e)));
                                }
                            }));
                        return;
                    }
                }
            }
        }));

        // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
        // Using this function will automatically remove the event listener when this plugin is disabled.
        this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
            console.log('click', evt);
        });

        // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
        this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

        // 添加 Ribbon icon：点击后重命名当前文档内所有图片
        this.addRibbonIcon('dice', 'AutoRename All Images', async () => {
            try {
                await this.renameAllImagesInActiveDoc();
            } catch (e) {
                new Notice('AutoRename All failed: ' + (e?.message ?? String(e)));
            }
        });
    }

    // 自动重命名函数：重命名 Vault 中文件并更新当前行中的链接文本
    private async autoRenameImage(view: MarkdownView, editor: Editor, lineNum: number, startCh: number, endCh: number, rawLink: string, kind: 'wiki' | 'inline', fullMatch: string) {
        // 清理 link（去除别名等）
        let link = rawLink.split('|')[0].trim();
        if (!link) {
            new Notice('无法解析图片路径');
            return;
        }

        // 排除外部链接
        if (/^[a-zA-Z]+:\/\//.test(link)) {
            new Notice('外部图片无法重命名');
            return;
        }

        const sourcePath = view.file.path;
        // 尝试通过 Obsidian 的链接解析先获取文件
        let file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath) as TFile || null;

        // 若未解析到，尝试几种相对路径猜测
        if (!file) {
            const folder = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '';
            const candidates = [
                link,
                (folder ? `${folder}/${link}` : link),
                link.replace(/^\//, '')
            ];
            for (const c of candidates) {
                const af = this.app.vault.getAbstractFileByPath(c);
                if (af && af instanceof TFile) {
                    file = af;
                    break;
                }
            }
        }

        if (!file) {
            new Notice('未找到图片文件：' + link);
            return;
        }

        // 生成新文件名：文档名-YYYYMMDD-HHMMSS.ext
        const ts = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        const timestamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
        const docBase = (view.file.basename) ? view.file.basename : view.file.name.replace(/\.[^/.]+$/, '');
        const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')) : '';
        const newName = `${docBase}-${timestamp}${ext}`;

        // 新路径保留原文件夹
        const fileFolder = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/') + 1) : '';
        const newPath = `${fileFolder}${newName}`;

        // 执行重命名
        await this.app.vault.rename(file, newPath);

        // 更新当前行的链接文本为新路径（保持原语法）
        let newText = '';
        if (kind === 'wiki') {
            // 保留可能的别名（rawLink 之前切分掉别名部分），若原 fullMatch 含 alias 则保留
            const aliasMatch = fullMatch.match(/\|(.+?)\]\]/);
            const alias = aliasMatch ? `|${aliasMatch[1]}` : '';
            newText = `![[${newPath}${alias}]]`;
        } else {
            // inline 语法：![](path)
            newText = fullMatch.replace(rawLink, newPath);
        }

        editor.replaceRange(newText, { line: lineNum, ch: startCh }, { line: lineNum, ch: endCh });
        new Notice('图片已重命名为：' + newName);
    }

    // 新方法：将当前文档内所有图片重命名为 文档名 + 图片修改时间，并更新文档内容中的链接
    private async renameAllImagesInActiveDoc() {
        const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!mdView || !mdView.file) {
            new Notice('当前没有打开 Markdown 文档');
            return;
        }
        const currentFile = mdView.file;
        let content = await this.app.vault.read(currentFile);

        // helper
        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // 找到文档中的图片链接（wiki 和 inline）
        const patterns = [
            { regex: /\!\[\[(.+?)(\|.*?)*\]\]/g, kind: 'wiki' },
            { regex: /\!\[([^\]]*?)\]\((.+?)\)/g, kind: 'inline' } // capture alt and path
        ];

        type RenameTask = { tfile: TFile, oldLink: string, newPath: string, kind: 'wiki' | 'inline' };

        const renameMap = new Map<string, RenameTask>(); // key: original resolved path in vault (file.path)

        for (const p of patterns) {
            p.regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = p.regex.exec(content)) !== null) {
                let rawLink = '';
                if (p.kind === 'wiki') {
                    rawLink = m[1];
                } else {
                    rawLink = m[2];
                }
                const link = rawLink.split('|')[0].trim();
                if (!link) continue;
                // skip external
                if (/^[a-zA-Z]+:\/\//.test(link)) continue;

                // resolve to TFile
                let target = this.app.metadataCache.getFirstLinkpathDest(link, currentFile.path) as TFile || null;
                if (!target) {
                    const folder = currentFile.path.includes('/') ? currentFile.path.substring(0, currentFile.path.lastIndexOf('/')) : '';
                    const candidates = [
                        link,
                        (folder ? `${folder}/${link}` : link),
                        link.replace(/^\//, '')
                    ];
                    for (const c of candidates) {
                        const af = this.app.vault.getAbstractFileByPath(c);
                        if (af && af instanceof TFile) {
                            target = af;
                            break;
                        }
                    }
                }
                if (!target) continue;

                // 如果已计划重命名则跳过
                if (renameMap.has(target.path)) continue;

                // 使用图片文件的修改时间生成时间戳
                const mtime = target.stat?.mtime ? new Date(target.stat.mtime) : new Date();
                const pad = (n: number) => n.toString().padStart(2, '0');
                const timestamp = `${mtime.getFullYear()}${pad(mtime.getMonth()+1)}${pad(mtime.getDate())}-${pad(mtime.getHours())}${pad(mtime.getMinutes())}${pad(mtime.getSeconds())}`;

                const docBase = currentFile.basename;
                const ext = target.name.includes('.') ? target.name.substring(target.name.lastIndexOf('.')) : '';
                const newName = `${docBase}-${timestamp}${ext}`;
                const folderPath = target.path.includes('/') ? target.path.substring(0, target.path.lastIndexOf('/') + 1) : '';
                const newPath = `${folderPath}${newName}`;

                renameMap.set(target.path, { tfile: target, oldLink: target.path, newPath, kind: p.kind as 'wiki' | 'inline' });
            }
        }

        if (renameMap.size === 0) {
            new Notice('未在文档中找到可重命名的本地图片');
            return;
        }

        // 执行重命名（顺序：逐个重命名）
        for (const [, task] of renameMap) {
            try {
                await this.app.vault.rename(task.tfile, task.newPath);
            } catch (e) {
                console.error('rename fail', task, e);
                new Notice('重命名失败: ' + task.tfile.name);
            }
        }

        // 更新文档内容：将旧路径替换为新路径（分别处理 wiki 和 inline，保留 alias/alt）
        let newContent = content;
        for (const [, task] of renameMap) {
            const oldRel = task.oldLink; // vault 中的相对路径形式
            const newRel = task.newPath;

            if (task.kind === 'wiki') {
                // ![[oldPath|alias]] 或 ![[oldPath]]
                const re = new RegExp(`!\\[\\[\\s*${escapeRegExp(oldRel)}(\\|[^\\]]*)?\\s*\\]\\]`, 'g');
                newContent = newContent.replace(re, (match, alias = '') => {
                    return `![[${newRel}${alias || ''}]]`;
                });
            } else {
                // inline: ![alt](oldPath)
                const re = new RegExp(`!\\[([^\\]]*?)\\]\\(\\s*${escapeRegExp(oldRel)}\\s*\\)`, 'g');
                newContent = newContent.replace(re, (match, alt = '') => {
                    return `![${alt}](${newRel})`;
                });
            }
        }

        // 写回文档
        await this.app.vault.modify(currentFile, newContent);
        new Notice(`已重命名 ${renameMap.size} 个图片并更新文档链接`);
    }

    onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
