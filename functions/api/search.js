// Cloudflare Pages Function: 工业级开源元搜索 + RSS 聚合架构
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

  const codeRegex = /(?:code|promo|coupon|use|discount)[:\s]+([A-Z0-9]{4,15})\b/i;
  const discountRegex = /(\b\d{1,2}%\s*off|\$\d+(?:\.\d{2})?\s*off\b)/i;

  // 识别渠道标签与配色
  const identifyPlatform = (url) => {
    if (/slickdeals\.net/i.test(url)) return 'Slickdeals';
    if (/dealnews\.com/i.test(url)) return 'DealNews';
    if (/facebook\.com/i.test(url)) return 'Facebook';
    if (/t\.me/i.test(url)) return 'Telegram';
    if (/reddit\.com/i.test(url)) return 'Reddit';
    if (/hip2save\.com/i.test(url)) return 'Hip2Save';
    return '独立Deal站/博客';
  };

  // ---------------- 抓取源 A: Slickdeals 原生 RSS (稳定出数) ----------------
  const fetchSlickdeals = async () => {
    try {
      const res = await fetch(`https://slickdeals.net/newsearch.php?q=${asin}&rss=1`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const items = [];
      const blocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

      for (const b of blocks) {
        const title = (b.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
        const link = (b.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
        const desc = (b.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim();

        items.push({
          platform: "Slickdeals",
          title,
          link,
          snippet: desc.slice(0, 180),
          date: 'RSS 收录',
          promo_code: (title + desc).match(codeRegex)?.[1] || null,
          discount: (title + desc).match(discountRegex)?.[1] || null
        });
      }
      return items;
    } catch { return []; }
  };

  // ---------------- 抓取源 B: 开源 SearXNG 元搜索集群 (穿透 FB/DealNews/Telegram) ----------------
  const fetchFromSearxng = async () => {
    // 优质公开免 Key 的 SearXNG 节点池，自动轮询容灾
    const nodes = [
      "https://searx.be",
      "https://search.sapti.me",
      "https://baresearch.org",
      "https://searx.tiekoetter.com"
    ];

    const dorkQuery = `"${asin}" (site:facebook.com OR site:dealnews.com OR site:t.me OR site:reddit.com OR site:hip2save.com)`;

    for (const node of nodes) {
      try {
        const targetUrl = `${node}/search?q=${encodeURIComponent(dorkQuery)}&format=json&categories=general`;
        const res = await fetch(targetUrl, {
          headers: { 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json"
          },
          signal: AbortSignal.timeout(6000) // 6秒超时换下一个节点
        });

        if (!res.ok) continue;
        const data = await res.json();
        
        if (data.results && data.results.length > 0) {
          return data.results.map(r => {
            const combinedText = `${r.title || ''} ${r.content || ''}`;
            return {
              platform: identifyPlatform(r.url),
              title: r.title || '站外促销帖子',
              link: r.url,
              snippet: (r.content || '').slice(0, 180),
              date: r.publishedDate ? r.publishedDate.slice(0, 10) : 'Google/Bing 缓存',
              promo_code: combinedText.match(codeRegex)?.[1] || null,
              discount: combinedText.match(discountRegex)?.[1] || null
            };
          });
        }
      } catch (err) {
        // 当前节点故障，尝试下一个
        continue;
      }
    }
    return [];
  };

  // 并发请求：Slickdeals RSS + SearXNG 元搜索网络
  const [sdResults, metaResults] = await Promise.all([
    fetchSlickdeals(),
    fetchFromSearxng()
  ]);

  // 去重合并
  const allRecords = [...sdResults];
  const existingLinks = new Set(sdResults.map(r => r.link));

  for (const r of metaResults) {
    if (!existingLinks.has(r.link)) {
      allRecords.push(r);
      existingLinks.add(r.link);
    }
  }

  const uniqueCodes = [...new Set(allRecords.map(r => r.promo_code).filter(Boolean))];

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
