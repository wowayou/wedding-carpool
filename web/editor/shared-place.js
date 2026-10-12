// ---------- 粘贴来的位置：从别人分享的链接、文字或坐标里认出地点 ----------
// 地址框里粘贴后点「搜索」：认得出坐标就直接给一个候选（不调用高德）；认不出就去掉链接和套话，用剩下的名称和地址去搜。
// 认得的坐标：高德 URI 链接（uri.amap.com 的 marker?position=经度,纬度&name=…、navigation?to=经度,纬度,名称），
// 以及文字里的「经度,纬度」或「纬度,经度」（按中国的经纬度范围分辨）。坐标按高德坐标（GCJ-02）理解。
// 高德 App 分享的短链接（surl.amap.com）要联网展开，这里不展开，只用它旁边的文字搜索。不依赖其他模块，导入时不碰页面

const LNG = [73, 136], LAT = [3, 54]; // 中国的经纬度大致范围；纬度上限小于经度下限，两个数谁是经度一看便知
const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
const fmt = (n) => Number(n).toFixed(6);

function pair(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (inRange(x, LNG) && inRange(y, LAT)) return `${fmt(x)},${fmt(y)}`;
  if (inRange(x, LAT) && inRange(y, LNG)) return `${fmt(y)},${fmt(x)}`;
  return null;
}

function fromUrl(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!/(^|\.)amap\.com$/i.test(url.hostname)) return null;
  const q = url.searchParams;
  const position = q.get('position');
  if (position) {
    const [a, b] = position.split(',');
    const location = pair(a, b);
    if (location) return { location, name: (q.get('name') || '').trim() };
  }
  const to = q.get('to'); // navigation?to=经度,纬度,名称
  if (to) {
    const [a, b, ...rest] = to.split(',');
    const location = pair(a, b);
    if (location) return { location, name: rest.join(',').trim() };
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s，。、；）)】」]+/gi;
// 分享文字里常见的套话：【高德地图】、「我在高德地图分享了……」「复制/点击/打开……」这类整句
const NOISE_RE = /【[^】]*】|我在[^，。\n]*分享[^，。\n：:]*[：:]?|(?:复制|点击|长按|打开)[^，。\n]*[，。]?|分享(?:位置|地点)[：:]?/g;

// 返回 { location, name } 或 { query } 或 null（原样搜索）
export function parseShared(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  for (const u of text.match(URL_RE) || []) {
    const hit = fromUrl(u);
    if (hit) {
      const rest = text.replace(URL_RE, ' ').replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
      return { location: hit.location, name: hit.name || rest.split(' ')[0] || '' };
    }
  }
  const coord = text.match(/(-?\d{1,3}\.\d{3,})\s*[,，\s]\s*(-?\d{1,3}\.\d{3,})/);
  if (coord) {
    const location = pair(coord[1], coord[2]);
    if (location) {
      const rest = text.replace(coord[0], ' ').replace(URL_RE, ' ').replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
      return { location, name: rest.slice(0, 40) };
    }
  }
  if (!/https?:\/\//i.test(text) && !text.match(NOISE_RE)) return null; // 普通的名称或地址：原样搜索
  const query = text.replace(URL_RE, ' ').replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return query ? { query } : null;
}
