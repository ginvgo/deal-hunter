// Cloudflare Pages Function: 全能多站点并发反查引擎 (/api/search)
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const target = searchParams.get('target') || '';

  // 1. 严格提取 ASIN
  const asinMatch = target.trim().match(/(?:\/dp\/|\/gp\/product\/|\/ASIN\/|^)([A-Z0-9]{10})(?:[/?&]|$)/i);
  if (!asinMatch) {
    return new Response(JSON.stringify({ error: "未能识别到合法的 10 位 ASIN" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const asin = asinMatch[1].toUpperCase();

  // 模拟全套真实浏览器头部，防止被直接 403 屏蔽
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };

  const codeRegex = /(?:code|promo|coupon|use|discount)[:\s]+([A-Z0-9]{4,15})\b/i;
  const discountRegex = /(\b\d{1,2}%\s*off|\$\d+(?:\.\d{2})?\s*off\b)/i;

  // ---------------- 抓取源 1: Slickdeals 官方 RSS ----------------
  const fetchSlickdeals = async () => {
    try {
      const res = await fetch(`https://slickdeals.net/newsearch.php?q=${asin}&rss=1`, { headers });
      if (!res.ok) return [];
      const xml = await res.text();
      const items = [];
      const blocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

      for (const b of blocks) {
        const title = (b.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
        const link = (b.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
        const desc = (b.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();
        const date = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').slice(0, 16);

        items.push({
          platform: "Slickdeals",
          title,
          link,
          snippet: desc.slice(0, 160),
          date: date || '历史发帖',
          promo_code: (title + desc).match(codeRegex)?.[1] || null,
          discount: (title + desc).match(discountRegex)?.[1] || null
        });
      }
      return items;
    } catch { return []; }
  };

  // ---------------- 抓取源 2: DealNews 实时检索 ----------------
  const fetchDealNews = async () => {
    try {
      const res = await fetch(`https://www.dealnews.com/s/?search=${asin}`, { headers });
      if (!res.ok) return [];
      const html = await res.text();
      const items = [];

      // 正则匹配 DealNews 搜索结果卡片
      const cardMatches = html.match(/<div class="content-card[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi) || [];
      for (const card of cardMatches) {
        const titleMatch = card.match(/<a[^>]+class="card-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        const link = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://www.dealnews.com${titleMatch[1]}`;
        const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
        const snippetMatch = card.match(/<div class="card-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        const fullText = `${title} ${snippet}`;
        items.push({
          platform: "DealNews",
          title,
          link,
          snippet: snippet.slice(0, 160),
          date: 'DealNews 收录',
          promo_code: fullText.match(codeRegex)?.[1] || null,
          discount: fullText.match(discountRegex)?.[1] || null
        });
      }
      return items;
    } catch { return []; }
  };

  // ---------------- 抓取源 3: Ben's Bargains (美国老牌 Deal 站) ----------------
  const fetchBensBargains = async () => {
    try {
      const res = await fetch(`https://bensbargains.com/search/${asin}/`, { headers });
      if (!res.ok) return [];
      const html = await res.text();
      const items = [];

      const dealBlocks = html.match(/<div class="deal-item[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi) || [];
      for (const block of dealBlocks) {
        const titleMatch = block.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        const link = titleMatch[1].startsWith('http') ? titleMatch[1] : `https://bensbargains.com${titleMatch[1]}`;
        const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
        const snippet = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);

        items.push({
          platform: "Ben's Bargains",
          title,
          link,
          snippet,
          date: '折扣帖',
          promo_code: (title + snippet).match(codeRegex)?.[1] || null,
          discount: (title + snippet).match(discountRegex)?.[1] || null
        });
      }
      return items;
    } catch { return []; }
  };

  // ---------------- 抓取源 4: 修复后的 Reddit API (绕过云端拦截) ----------------
  const fetchReddit = async () => {
    try {
      // 必须加上 Reddit 官方认可格式的 User-Agent 才能避免 403 / 429
      const redditHeaders = {
        "User-Agent": `web:amazon-deal-tracker:v1.3 (by /u/deals_watcher_${Math.floor(Math.random()*10000)})`
      };
      const res = await fetch(`https://www.reddit.com/search.json?q=${asin}&sort=new&limit=15`, {
        headers: redditHeaders
      });
      if (!res.ok) return [];
      const data = await res.json();
      const children = data?.data?.children || [];

      return children.map(c => {
        const d = c.data || {};
        const title = d.title || '';
        const text = d.selftext || '';
        const fullText = `${title} ${text}`;

        return {
          platform: `Reddit (r/${d.subreddit})`,
          title: title,
          link: `https://www.reddit.com${d.permalink}`,
          snippet: text ? text.slice(0, 160) : 'Reddit 促销讨论与分享帖',
          date: 'Reddit 帖子',
          promo_code: fullText.match(codeRegex)?.[1] || null,
          discount: fullText.match(discountRegex)?.[1] || null
        };
      });
    } catch { return []; }
  };

  // 2. 并发向所有数据源开火
  const [sdData, dnData, bbData, rdData] = await Promise.all([
    fetchSlickdeals(),
    fetchDealNews(),
    fetchBensBargains(),
    fetchReddit()
  ]);

  const allRecords = [...sdData, ...dnData, ...bbData, ...rdData];
  const uniqueCodes = [...new Set(allRecords.map(r => r.promo_code).filter(Boolean))];

  // 3. 返回清洗好的结构化数据
  return new Response(JSON.stringify({
    status: "success",
    asin: asin,
    total: allRecords.length,
    unique_codes: uniqueCodes,
    keepa_chart: `https://graph.keepa.com/pricehistory.png?asin=${asin}&domain=com`,
    records: allRecords
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
