import http from 'node:http';
import { readFile, mkdir, writeFile, unlink, stat, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
function parseConfigYaml(source) {
  const config = {}; let section = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const sectionMatch = line.match(/^([A-Za-z_][\w-]*):\s*$/);
    if (sectionMatch) { section = sectionMatch[1]; config[section] ||= {}; continue; }
    const valueMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (!valueMatch || !section) continue;
    let value = valueMatch[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    config[section][valueMatch[1]] = value;
  }
  return config;
}
let appConfig = {};
try { appConfig = parseConfigYaml(await readFile(path.join(appRoot, 'config.yml'), 'utf8')); } catch {}
const root = path.join(appRoot, 'web', 'public');
const projectsDir = path.join(appRoot, '.data', 'projects');
const generatedDir = path.join(root, 'cat-meme-theater', 'generated');
const exportsDir = path.join(root, 'cat-meme-theater', 'exports');
const showcaseDir = path.join(root, 'cat-meme-theater', 'showcase');
const showcaseVideoExtensions = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const presetBackgrounds = new Map([
  ['office', 'bg-office-export.png'], ['server', 'bg-server-export.png'], ['home', 'bg-home-export.png'],
  ['street', 'bg-street-export.png'], ['stage', 'bg-stage-export.png'], ['space', 'bg-space-export.png']
]);
const clipCatalogPath = path.join(root, 'cat-meme-theater', 'assets', 'clip-catalog.json');
const clipCatalogScriptPath = path.join(root, 'cat-meme-theater', 'assets', 'clip-catalog.js');
const clipCatalog = JSON.parse(await readFile(clipCatalogPath, 'utf8'));
const clipIds = new Set(clipCatalog.map(clip => clip.id));
const buildClipBrief = () => clipCatalog.map(clip => `${clip.id}|${clip.name}|${clip.description}|${clip.tags.join('/')}`).join('\n');
const port = Number(appConfig.server?.port || 4173);
// 容器里必须绑 0.0.0.0，否则平台反向代理连不上；本地默认仍只听 127.0.0.1
const host = String(process.env.SERVER_HOST || appConfig.server?.host || '127.0.0.1');
const runtimeApiKey = String(appConfig.agnes?.api_key || '').trim();
const runtimeAdminToken = String(appConfig.admin?.token || '').trim();
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4'
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function requestClientId(req) {
  const id = String(req.headers['x-client-id'] || '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null;
}

function requireClientId(req, res) {
  const id = requestClientId(req);
  if (!id) json(res, 400, { error: '缺少有效的匿名用户 ID' });
  return id;
}

function requestIsAdmin(req) {
  return Boolean(runtimeAdminToken) && String(req.headers['x-admin-token'] || '') === runtimeAdminToken;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('请求内容过大');
  }
  return JSON.parse(raw || '{}');
}

async function persistClipCatalog() {
  await Promise.all([
    writeFile(clipCatalogPath, `${JSON.stringify(clipCatalog, null, 2)}\n`),
    writeFile(clipCatalogScriptPath, `window.CAT_CLIPS = ${JSON.stringify(clipCatalog)};\n`)
  ]);
}

async function deleteClip(res, id) {
  try {
    const index = clipCatalog.findIndex(item => item.id === id);
    if (index < 0) return json(res, 404, { error: '没有找到该素材' });
    const [clip] = clipCatalog.splice(index, 1);
    clipIds.delete(id);
    await persistClipCatalog();
    const theaterRoot = path.join(root, 'cat-meme-theater');
    const mediaPath = path.resolve(theaterRoot, clip.src);
    const posterPath = path.resolve(theaterRoot, clip.poster);
    for (const filePath of [mediaPath, posterPath]) {
      if (filePath.startsWith(theaterRoot + path.sep)) await unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    json(res, 200, { deleted: id, remaining: clipCatalog.length });
  } catch (error) {
    json(res, 500, { error: error.message || '删除素材失败' });
  }
}

async function updateClip(req, res, id) {
  try {
    const clip = clipCatalog.find(item => item.id === id);
    if (!clip) return json(res, 404, { error: '没有找到该素材' });
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const inputTags = Array.isArray(body.tags) ? body.tags : [];
    if (name.length < 1 || name.length > 30) return json(res, 400, { error: '名称长度需要在 1 到 30 字之间' });
    if (description.length < 2 || description.length > 600) return json(res, 400, { error: '画面描述长度需要在 2 到 600 字之间' });
    const tags = ['全部', ...new Set(inputTags.map(tag => String(tag).trim()).filter(tag => tag && tag !== '全部').slice(0, 12))];
    if (tags.some(tag => tag.length > 20)) return json(res, 400, { error: '单个标签不能超过 20 字' });

    clip.name = name;
    clip.description = description;
    clip.tags = tags;
    await persistClipCatalog();
    json(res, 200, { clip });
  } catch (error) {
    json(res, 500, { error: error.message || '保存素材资料失败' });
  }
}

async function runtimeMemory() {
  const memory = process.memoryUsage();
  const result = { rssMiB: Math.round(memory.rss / 1048576), heapMiB: Math.round(memory.heapUsed / 1048576) };
  try {
    const [current, max, events, oomGroup] = await Promise.all([
      readFile('/sys/fs/cgroup/memory.current', 'utf8'),
      readFile('/sys/fs/cgroup/memory.max', 'utf8'),
      readFile('/sys/fs/cgroup/memory.events', 'utf8'),
      readFile('/sys/fs/cgroup/memory.oom.group', 'utf8').catch(() => 'unknown')
    ]);
    result.cgroupMiB = Math.round(Number(current.trim()) / 1048576);
    result.limitMiB = max.trim() === 'max' ? 'max' : Math.round(Number(max.trim()) / 1048576);
    result.oom = Number(events.match(/^oom\s+(\d+)/m)?.[1] || 0);
    result.oomKill = Number(events.match(/^oom_kill\s+(\d+)/m)?.[1] || 0);
    result.oomGroup = oomGroup.trim();
  } catch {}
  return result;
}

async function collectVideoFiles(dir, depth = 0) {
  if (depth > 2) return [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...await collectVideoFiles(full, depth + 1)); continue; }
    if (!entry.isFile() || !showcaseVideoExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(full).catch(() => null);
    found.push({ fullPath: full, name: entry.name, mtimeMs: info ? info.mtimeMs : 0 });
  }
  return found;
}

function publicUrlFor(filePath) {
  return `/${path.relative(root, filePath).split(path.sep).map(encodeURIComponent).join('/')}`;
}

// 案例区数据：showcase 目录下人工放置的案例优先，其次自动收集用户导出的成片。
async function listShowcase(req, res) {
  const featured = [];
  const showcaseFiles = (await collectVideoFiles(showcaseDir)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if (showcaseFiles.length) {
    let meta = {};
    try {
      const parsed = JSON.parse(await readFile(path.join(showcaseDir, 'cases.json'), 'utf8'));
      if (Array.isArray(parsed)) for (const item of parsed) if (item && item.file) meta[item.file] = item;
    } catch {}
    for (const file of showcaseFiles) {
      const info = meta[file.name] || {};
      const fallbackTitle = file.name.replace(/\.[^.]+$/, '').replace(/^\d+[-_\s]*/, '');
      featured.push({
        url: publicUrlFor(file.fullPath),
        title: String(info.title || '').trim() || fallbackTitle || '猫 meme 案例',
        note: String(info.note || info.caption || '').trim(),
        createdAt: file.mtimeMs,
        source: 'showcase'
      });
    }
  }

  const exported = (await collectVideoFiles(exportsDir))
    .filter(file => path.extname(file.name).toLowerCase() === '.mp4')
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  json(res, 200, {
    featured,
    exported: exported.slice(0, 12).map(file => ({
      url: publicUrlFor(file.fullPath),
      title: '',
      note: '',
      createdAt: file.mtimeMs,
      source: 'export'
    })),
    exportedTotal: exported.length
  });
}

async function loadProjectState(req, res) {
  const clientId = requireClientId(req, res); if (!clientId) return;
  try {
    const projectPath = path.join(projectsDir, `${clientId}.json`);
    if (!existsSync(projectPath)) return json(res, 404, { project: null });
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    json(res, 200, { project });
  } catch (error) {
    json(res, 500, { error: error.message || '读取项目失败' });
  }
}

async function saveProjectState(req, res) {
  const clientId = requireClientId(req, res); if (!clientId) return;
  try {
    const project = await readJson(req);
    if (!project || !Array.isArray(project.scenes) || project.scenes.length < 1 || project.scenes.length > 40) return json(res, 400, { error: '项目数据无效' });
    project.savedAt = Date.now(); project.clientId = clientId;
    await mkdir(projectsDir, { recursive: true });
    await writeFile(path.join(projectsDir, `${clientId}.json`), `${JSON.stringify(project, null, 2)}\n`);
    json(res, 200, { ok: true, savedAt: project.savedAt });
  } catch (error) {
    json(res, 500, { error: error.message || '保存项目失败' });
  }
}

async function expandStory(req, res) {
  const apiKey = runtimeApiKey;
  if (!apiKey) return json(res, 503, { error: '服务器尚未配置 Agnes API Key，请在 config.yml 中填写 agnes.api_key', code: 'AGNES_KEY_REQUIRED' });

  try {
    const { idea, style = '爆笑反转' } = await readJson(req);
    if (typeof idea !== 'string' || idea.trim().length < 2 || idea.length > 300) {
      return json(res, 400, { error: '故事创意长度需要在 2 到 300 字之间' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const upstream = await fetch('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-3.0-flash',
        messages: [
          {
            role: 'system',
            content: '你是猫 meme 短剧编剧。把用户的一句话创意扩写为适合 15 到 45 秒的中文小故事。必须有清晰的起因、冲突升级、笑点和完整结局，所有角色尽量用猫来表现。目标长度为 220 到 260 个中文字符，含标点绝对不得超过 300 个字符，并以完整句号收尾。故事中的每个关键事件都应清楚可视化，以便之后按实际叙事需要拆成数量不固定的镜头。只输出连贯的故事正文，不要标题、分镜编号、解释、Markdown 或引号。'
          },
          { role: 'user', content: `剧情风格：${String(style).slice(0, 20)}\n原始创意：${idea.trim()}` }
        ],
        temperature: 0.85,
        max_tokens: 420,
        chat_template_kwargs: { enable_thinking: false }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: payload.error?.message || payload.message || 'Agnes 故事扩写失败' });
    let story = payload.choices?.[0]?.message?.content;
    if (typeof story !== 'string' || !story.trim()) return json(res, 502, { error: '文本模型没有返回有效故事' });
    story = story.replace(/```[\s\S]*?```/g, block => block.replace(/```(?:\w+)?|```/g, '')).replace(/^\s*["“]|["”]\s*$/g, '').trim();
    if (story.length > 300) {
      const candidate = story.slice(0, 300);
      const endings = [...candidate.matchAll(/[。！？]/g)];
      const lastComplete = endings.filter(match => match.index >= 160).at(-1);
      story = lastComplete ? candidate.slice(0, lastComplete.index + 1) : `${candidate.slice(0, 299).replace(/[，、；：\s]+$/g, '')}。`;
    }
    if (!/[。！？]$/.test(story)) story = `${story.slice(0, 299).replace(/[，、；：\s]+$/g, '')}。`;
    json(res, 200, { story, length: story.length, model: 'agnes-3.0-flash' });
  } catch (error) {
    const message = error.name === 'AbortError' ? '故事扩写超时，请重试' : error.message;
    json(res, 500, { error: message || '故事扩写失败' });
  }
}

async function generateStoryboard(req, res) {
  const apiKey = runtimeApiKey;
  if (!apiKey) return json(res, 503, { error: '服务器尚未配置 Agnes API Key，请在 config.yml 中填写 agnes.api_key', code: 'AGNES_KEY_REQUIRED' });

  try {
    const { story, style = '爆笑反转', duration = '约 30 秒' } = await readJson(req);
    if (typeof story !== 'string' || story.trim().length < 10 || story.length > 300) {
      return json(res, 400, { error: '请先准备一段 10 到 300 字的完整故事' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const upstream = await fetch('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-3.0-flash',
        messages: [
          {
            role: 'system',
            content: `你是猫 meme 短视频导演。先识别完整故事中的所有关键叙事节点，再按实际需要拆成数量动态的连续分镜，不得为了凑固定数量而删减、合并或编造情节。每当地点、时间、角色动作、情绪或叙事作用发生明显变化时，就建立一个新镜头；简单故事可以少，复杂故事可以多。第一个镜头必须交代开端，最后一个镜头必须完整呈现用户故事的真实结局，按顺序阅读所有 caption 应能复述整个故事且没有剧情跳跃。根据目标时长为每幕分配 2 到 8 秒。\n\n从给定素材库中为每一幕选择最符合动作和情绪的真实素材 ID。不能使用列表之外的 ID，不能固定套用示例。优先选择猫素材和资料准确的已校准素材；带有“待校准”标签的素材描述尚不可靠，除非没有合适的已校准素材，否则不要选择。只有故事明确需要或没有合适猫素材时才能选择其他角色。backgroundPrompt 必须根据该幕的地点、时间、天气、道具和情绪氛围编写，只描述无人空镜环境，禁止描述或提及剧情中的角色、动作和对白，禁止出现人类、猫、其他动物、脸、身体、剪影、雕像、照片、海报人物、文字或标志；画面中央必须留出角色表演空间。只返回合法 JSON，不要 Markdown。格式：{"title":"短标题","scenes":[{"name":"幕名","caption":"台词或旁白","duration":4,"clipId":"三位素材ID","clipReason":"动作情绪匹配理由","backgroundPrompt":"具体场景、时间、光线和氛围"}]}。\n\n可用素材库（ID|名称|画面描述|标签）：\n${buildClipBrief()}`
          },
          { role: 'user', content: `风格：${String(style).slice(0, 20)}\n目标时长：${String(duration).slice(0, 20)}\n完整故事：${story.trim()}` }
        ],
        temperature: 0.45,
        max_tokens: 5000,
        chat_template_kwargs: { enable_thinking: false }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: payload.error?.message || payload.message || 'Agnes 分镜生成失败' });
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return json(res, 502, { error: '模型没有返回有效分镜' });
    const start = content.indexOf('{'), end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return json(res, 502, { error: '模型返回的分镜格式无效' });
    const project = JSON.parse(content.slice(start, end + 1));
    if (!Array.isArray(project.scenes) || project.scenes.length === 0) return json(res, 502, { error: '模型没有生成有效分镜' });

    const scenes = project.scenes.map((scene, index) => {
      const id = String(scene.clipId || '').padStart(3, '0');
      if (!clipIds.has(id)) throw new Error(`第 ${index + 1} 幕选择了不存在的素材`);
      return {
        name: String(scene.name || `第 ${index + 1} 幕`).slice(0, 16),
        caption: String(scene.caption || '').slice(0, 100),
        duration: Math.max(2, Math.min(8, Number(scene.duration) || 4)),
        clip: id,
        clipReason: String(scene.clipReason || '').slice(0, 100),
        backgroundPrompt: String(scene.backgroundPrompt || '').slice(0, 600),
        bg: 'office'
      };
    });
    json(res, 200, { title: String(project.title || '新鲜猫剧场').slice(0, 24), scenes, model: 'agnes-3.0-flash' });
  } catch (error) {
    const message = error.name === 'AbortError' ? '分镜生成超时，请重试' : error.message;
    json(res, 500, { error: message || '分镜生成失败' });
  }
}

async function matchClip(req, res) {
  const apiKey = runtimeApiKey;
  if (!apiKey) return json(res, 503, { error: '服务器尚未配置 Agnes API Key，请在 config.yml 中填写 agnes.api_key', code: 'AGNES_KEY_REQUIRED' });
  try {
    const { name = '', caption = '', story = '', currentClip = '' } = await readJson(req);
    if (!String(caption).trim()) return json(res, 400, { error: '请先填写这一幕的字幕或剧情' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const upstream = await fetch('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-3.0-flash',
        messages: [
          { role: 'system', content: `你是猫 meme 短剧选角导演。只为当前这一幕从真实素材库中选择一个动作和情绪最匹配的素材。优先选择猫和资料准确的素材，不得编造 ID。避免只按名称匹配，要根据完整画面描述判断动作过程。只返回合法 JSON：{"clipId":"三位ID","reason":"一句具体的选角理由"}。\n\n素材库（ID|名称|描述|标签）：\n${buildClipBrief()}` },
          { role: 'user', content: `完整故事：${String(story).slice(0,300)}\n当前幕：${String(name).slice(0,30)}\n当前幕字幕：${String(caption).slice(0,120)}\n目前素材：${String(currentClip).slice(0,10)}。请重新判断最合适的演员。` }
        ],
        temperature: .25,
        max_tokens: 300,
        chat_template_kwargs: { enable_thinking: false }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: payload.error?.message || payload.message || 'Agnes 选角失败' });
    const content = payload.choices?.[0]?.message?.content || '';
    const start = content.indexOf('{'), end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return json(res, 502, { error: '模型没有返回有效选角结果' });
    const result = JSON.parse(content.slice(start, end + 1));
    const id = String(result.clipId || '').padStart(3, '0');
    if (!clipIds.has(id)) return json(res, 502, { error: '模型选择了不存在的素材' });
    json(res, 200, { clip: id, reason: String(result.reason || '动作和情绪与当前分镜匹配').slice(0, 120) });
  } catch (error) {
    json(res, 500, { error: error.name === 'AbortError' ? 'AI 选角超时，请重试' : error.message || 'AI 选角失败' });
  }
}

async function generateBackground(req, res) {
  const clientId = requireClientId(req, res); if (!clientId) return;
  const apiKey = runtimeApiKey;
  if (!apiKey) return json(res, 503, { error: '服务器尚未配置 Agnes API Key，请在 config.yml 中填写 agnes.api_key', code: 'AGNES_KEY_REQUIRED' });

  try {
    const { prompt, ratio = '9:16' } = await readJson(req);
    if (!['9:16', '16:9', '1:1'].includes(ratio)) return json(res, 400, { error: '不支持的画面比例' });
    if (typeof prompt !== 'string' || prompt.trim().length < 4 || prompt.length > 1200) {
      return json(res, 400, { error: '场景描述长度需要在 4 到 1200 字之间' });
    }

    const environmentPrompt = [
      '只生成用于绿幕合成的无人空镜背景。画面只能包含环境、建筑、家具、道具、天气和光线。',
      `当前分镜的环境描述：${prompt.trim()}`,
      '忽略环境描述中可能出现的任何角色、人物动作或对白，只保留与剧情相符的地点、时间、道具和氛围。',
      '严格禁止：人类、猫、狗、任何动物、角色、脸、身体、手脚、剪影、雕像、玩偶、照片、海报人物、屏幕中的人、文字、字幕、字母、数字、标志和水印。',
      `画面比例 ${ratio}，电影级写实，细节丰富，前后景层次清晰；画面中央和下方保持开阔，留给后期叠加完整猫咪演员。`,
      'EMPTY ENVIRONMENT BACKGROUND ONLY. NO PEOPLE, NO ANIMALS, NO CHARACTERS, NO TEXT.'
    ].join('\n');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    const upstream = await fetch('https://api.agnes-ai.cn/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-image-2.5-flash',
        prompt: environmentPrompt,
        size: '1K',
        ratio,
        extra_body: { response_format: 'url' }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(res, upstream.status, { error: payload.error?.message || payload.message || 'Agnes 图片生成失败' });
    const imageUrl = payload.data?.[0]?.url;
    if (!imageUrl || !imageUrl.startsWith('https://')) return json(res, 502, { error: '图片模型没有返回有效地址' });

    const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(120_000) });
    if (!imageResponse.ok) return json(res, 502, { error: '无法下载生成的背景图' });
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) return json(res, 502, { error: '生成的背景图尺寸过大' });

    const userGeneratedDir = path.join(generatedDir, clientId);
    await mkdir(userGeneratedDir, { recursive: true });
    const filename = `${randomUUID()}.png`;
    await writeFile(path.join(userGeneratedDir, filename), bytes);
    json(res, 200, { url: `/cat-meme-theater/generated/${clientId}/${filename}` });
  } catch (error) {
    const message = error.name === 'AbortError' || error.name === 'TimeoutError' ? '图片生成超时，请重试' : error.message;
    json(res, 500, { error: message || '图片生成失败' });
  }
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (requestPath === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
  const routeAliases = new Map([
    ['/', '/index.html'], ['/home', '/index.html'], ['/home/', '/index.html'],
    ['/app', '/cat-meme-theater/index.html'], ['/app/', '/cat-meme-theater/index.html']
  ]);
  const relative = (routeAliases.get(requestPath) || requestPath).replace(/^\/+/, '');
  let filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root + path.sep)) return json(res, 403, { error: '禁止访问' });
  if (existsSync(filePath) && !path.extname(filePath)) filePath = path.join(filePath, 'index.html');
  if (!existsSync(filePath) && requestPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
  if (!existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath).toLowerCase();
  const fileStat = await stat(filePath);
  const range = req.headers.range;
  const baseHeaders = { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'Accept-Ranges': 'bytes' };
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) { res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileStat.size}` }); return res.end(); }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
    if (start > end || start >= fileStat.size) { res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${fileStat.size}` }); return res.end(); }
    res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${fileStat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': fileStat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/project') return loadProjectState(req, res);
  if (req.method === 'PUT' && req.url === '/api/project') return saveProjectState(req, res);
  if (req.method === 'POST' && req.url === '/api/admin/check') return requestIsAdmin(req) ? json(res, 200, { ok: true }) : json(res, 403, { error: '管理员令牌无效' });
  if (req.method === 'GET' && req.url === '/api/clips') return json(res, 200, { clips: clipCatalog });
  if (req.method === 'GET' && req.url === '/api/showcase') return listShowcase(req, res);
  const clipMatch = req.url.match(/^\/api\/clips\/([0-9]{3})$/);
  if (req.method === 'PUT' && clipMatch) { if (!requestIsAdmin(req)) return json(res, 403, { error: '需要管理员权限' }); return updateClip(req, res, clipMatch[1]); }
  if (req.method === 'DELETE' && clipMatch) { if (!requestIsAdmin(req)) return json(res, 403, { error: '需要管理员权限' }); return deleteClip(res, clipMatch[1]); }
  if (req.method === 'POST' && req.url === '/api/export-video') return json(res, 410, { error: '视频已改为在浏览器本地导出，请使用创作台的“导出 MP4”按钮' });
  if (req.method === 'POST' && req.url === '/api/expand-story') return expandStory(req, res);
  if (req.method === 'POST' && req.url === '/api/generate-storyboard') return generateStoryboard(req, res);
  if (req.method === 'POST' && req.url === '/api/match-clip') return matchClip(req, res);
  if (req.method === 'POST' && req.url === '/api/generate-background') return generateBackground(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  json(res, 405, { error: 'Method not allowed' });
});

server.listen(port, host, async () => {
  console.log(`Cat Meme Theater running at http://${host}:${port}/ (创作台 /cat-meme-theater/)`);
  console.log(`[runtime:start] pid=${process.pid} memory=${JSON.stringify(await runtimeMemory())}`);
});
const runtimeHeartbeat = setInterval(async () => {
  console.log(`[runtime:heartbeat] memory=${JSON.stringify(await runtimeMemory())}`);
}, 60_000);
runtimeHeartbeat.unref?.();
process.on('SIGTERM', async () => {
  console.error(`[runtime:signal] SIGTERM memory=${JSON.stringify(await runtimeMemory())}`);
  process.exit(0);
});
process.on('uncaughtException', async error => {
  console.error(`[runtime:uncaught] ${error?.stack || error} memory=${JSON.stringify(await runtimeMemory())}`);
  process.exit(1);
});
process.on('unhandledRejection', async error => {
  console.error(`[runtime:unhandled] ${error?.stack || error} memory=${JSON.stringify(await runtimeMemory())}`);
});
