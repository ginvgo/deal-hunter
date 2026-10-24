// Cloudflare Pages Function: 对应请求路径 /api/search
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
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // 正则规则库：提取促销码与折扣
  const codeRegex = /(?:code|promo|coupon|use|discount)[:\s]+([A-Z0-9]{4,15})\b/i;
  const discountRegex = /(\b\d{1,2}%\s*off|\$\d+(?:\.\d{2})?\s*off\b)/i;

  // 抓取源 1: Slickdeals 官方公开 RSS (免验证码拦截)
  const fetchSlickdeals = async () => {
    try {
      const res = await fetch(`https://slickdeals.net/newsearch.php?q=${asin}&rss=1`, {
        headers: { "User-Agent": userAgent }
      });
      if (!res.ok) return [];
      const xmlText = await res.text();

      const items = [];
      const itemBlocks = xmlText.match(/<item>([\s\S]*?)<\/item>/gi) || [];

      for (const block of itemBlocks) {
        const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
        const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
        const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
        const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

        const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
        const desc = descMatch ? descMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
        const fullText = `${title} ${desc}`;

        const cMatch = fullText.match(codeRegex);
        const dMatch = fullText.match(discountRegex);

        items.push({
          platform: "Slickdeals",
          title: title,
          link: linkMatch ? linkMatch[1].trim() : '',
          snippet: desc.slice(0, 180),
          date: dateMatch ? dateMatch[1].slice(0, 16) : '近期发帖',
          promo_code: cMatch ? cMatch[1] : null,
          discount: dMatch ? dMatch[1] : null
        });
      }
      return items;
    } catch (e) {
      return [];
    }
  };

  // 抓取源 2: Reddit 全网公开 Deals 节点
  const fetchReddit = async () => {
    try {
      const res = await fetch(`https://www.reddit.com/search.json?q=${asin}&sort=new&limit=15`, {
        headers: { "User-Agent": userAgent }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const children = data?.data?.children || [];

      return children.map(c => {
        const d = c.data || {};
        const title = d.title || '';
        const text = d.selftext || '';
        const fullText = `${title} ${text}`;

        const cMatch = fullText.match(codeRegex);
        const dMatch = fullText.match(discountRegex);

        return {
          platform: `Reddit (r/${d.subreddit})`,
          title: title,
          link: `https://www.reddit.com${d.permalink}`,
          snippet: text ? text.slice(0, 180) : '亚马逊 Deals 讨论与分享贴',
          date: '近期发帖',
          promo_code: cMatch ? cMatch[1] : null,
          discount: dMatch ? dMatch[1] : null
        };
      });
    } catch (e) {
      return [];
    }
  };

  // 抓取源 3: Telegram 海外公开促销大频道镜像
  const fetchTelegram = async () => {
    const channels = ["amazondeals", "dealsplus", "crazypromocodes"];
    const results = [];

    await Promise.all(channels.map(async (ch) => {
      try {
        const res = await fetch(`https://t.me/s/${ch}?q=${asin}`, {
          headers: { "User-Agent": userAgent }
        });
        if (!res.ok) return;
        const html = await res.text();

        // 匹配消息块
        const matches = html.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) || [];
        for (const m of matches) {
          const rawText = m.replace(/<[^>]+>/g, '').trim();
          if (!rawText.toLowerCase().includes(asin.toLowerCase())) continue;

          const cMatch = rawText.match(codeRegex);
          const dMatch = rawText.match(discountRegex);

          results.push({
            platform: `Telegram (@${ch})`,
            title: rawText.slice(0, 75) + '...',
            link: `https://t.me/s/${ch}`,
            snippet: rawText.slice(0, 180),
            date: '群消息流',
            promo_code: cMatch ? cMatch[1] : null,
            discount: dMatch ? dMatch[1] : null
          });
        }
      } catch (err) {}
    }));

    return results;
  };

  // 2. 并发执行多源抓取任务
  const [sdData, rdData, tgData] = await Promise.all([
    fetchSlickdeals(),
    fetchReddit(),
    fetchTelegram()
  ]);

  const allRecords = [...sdData, ...rdData, ...tgData];
  const uniqueCodes = [...new Set(allRecords.map(r => r.promo_code).filter(Boolean))];

  // 3. 返回结构化 JSON 数据
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
