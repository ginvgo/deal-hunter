import re
import asyncio
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Amazon Offsite Deal Radar Engine")

# 允许跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CODE_REGEX = re.compile(r'(?:code|promo|coupon|use|discount)[:\s]+([A-Z0-9]{4,15})\b', re.IGNORECASE)
DISCOUNT_REGEX = re.compile(r'(\b\d{1,2}%\s*off|\$\d+(?:\.\d{2})?\s*off\b)', re.IGNORECASE)
ASIN_REGEX = re.compile(r'(?:/dp/|/gp/product/|/ASIN/|^)([A-Z0-9]{10})(?:[/?&]|$)', re.IGNORECASE)

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# 抓取源 1: Slickdeals 官方公开 RSS 检索流 (无 Cloudflare 验证码拦截)
async def fetch_slickdeals(asin: str, client: httpx.AsyncClient):
    url = f"https://slickdeals.net/newsearch.php?q={asin}&rss=1"
    try:
        res = await client.get(url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if res.status_code != 200:
            return []
        
        soup = BeautifulSoup(res.text, "xml")
        items = soup.find_all("item")
        results = []
        for item in items:
            title = item.find("title").get_text() if item.find("title") else ""
            desc = item.find("description").get_text() if item.find("description") else ""
            link = item.find("link").get_text() if item.find("link") else ""
            pub_date = item.find("pubDate").get_text() if item.find("pubDate") else ""

            combined_text = f"{title} {desc}"
            code_match = CODE_REGEX.search(combined_text)
            discount_match = DISCOUNT_REGEX.search(combined_text)

            results.append({
                "platform": "Slickdeals",
                "title": title,
                "link": link,
                "snippet": re.sub(r'<[^>]+>', '', desc)[:200],
                "date": pub_date[:16] if pub_date else "近期",
                "promo_code": code_match.group(1) if code_match else None,
                "discount": discount_match.group(1) if discount_match else None
            })
        return results
    except Exception as e:
        print(f"Slickdeals error: {e}")
        return []

# 抓取源 2: Reddit 全站公开 Deal 节点
async def fetch_reddit(asin: str, client: httpx.AsyncClient):
    url = f"https://www.reddit.com/search.json?q={asin}&sort=new&limit=15"
    try:
        res = await client.get(url, headers={"User-Agent": USER_AGENT}, timeout=8.0)
        if res.status_code != 200:
            return []
        
        data = res.json()
        results = []
        children = data.get("data", {}).get("children", [])
        for c in children:
            d = c.get("data", {})
            title = d.get("title", "")
            selftext = d.get("selftext", "")
            combined_text = f"{title} {selftext}"

            code_match = CODE_REGEX.search(combined_text)
            discount_match = DISCOUNT_REGEX.search(combined_text)

            results.append({
                "platform": f"Reddit (r/{d.get('subreddit')})",
                "title": title,
                "link": f"https://www.reddit.com{d.get('permalink')}",
                "snippet": selftext[:200] if selftext else "亚马逊 Deal 分享贴",
                "date": "近期",
                "promo_code": code_match.group(1) if code_match else None,
                "discount": discount_match.group(1) if discount_match else None
            })
        return results
    except Exception as e:
        print(f"Reddit error: {e}")
        return []

# 抓取源 3: Telegram 海外知名公开 Deal 频道镜像流
async def fetch_telegram_mirrors(asin: str, client: httpx.AsyncClient):
    # 海外最大的公开亚马逊促销转发频道
    channels = ["amazondeals", "dealsplus", "crazypromocodes"]
    results = []

    for ch in channels:
        url = f"https://t.me/s/{ch}?q={asin}"
        try:
            res = await client.get(url, headers={"User-Agent": USER_AGENT}, timeout=6.0)
            if res.status_code != 200:
                continue
            soup = BeautifulSoup(res.text, "html.parser")
            messages = soup.find_all("div", class_="tgme_widget_message_wrap")
            for msg in messages:
                text_el = msg.find("div", class_="tgme_widget_message_text")
                if not text_el or asin.lower() not in text_el.get_text().lower():
                    continue

                raw_text = text_el.get_text()
                code_match = CODE_REGEX.search(raw_text)
                discount_match = DISCOUNT_REGEX.search(raw_text)

                results.append({
                    "platform": f"Telegram (@{ch})",
                    "title": raw_text[:80] + "...",
                    "link": f"https://t.me/s/{ch}",
                    "snippet": raw_text[:200],
                    "date": "近期群消息",
                    "promo_code": code_match.group(1) if code_match else None,
                    "discount": discount_match.group(1) if discount_match else None
                })
        except Exception:
            continue
    return results

@app.get("/api/search")
async def search_offsite_promotions(target: str = Query(..., description="ASIN 或亚马逊完整 URL")):
    match = ASIN_REGEX.search(target.strip())
    if not match:
        raise HTTPException(status_code=400, detail="未能识别到合法的 10 位 ASIN 码")
    
    asin = match.group(1).upper()

    # 异步并发抓取多源
    async with httpx.AsyncClient(follow_redirects=True) as client:
        sd_task = fetch_slickdeals(asin, client)
        rd_task = fetch_reddit(asin, client)
        tg_task = fetch_telegram_mirrors(asin, client)

        sd_res, rd_res, tg_res = await asyncio.gather(sd_task, rd_task, tg_task)

    all_records = sd_res + rd_res + tg_res
    unique_codes = list(set([r["promo_code"] for r in all_records if r["promo_code"]]))

    return {
        "status": "success",
        "asin": asin,
        "total": len(all_records),
        "unique_codes": unique_codes,
        "keepa_chart": f"https://graph.keepa.com/pricehistory.png?asin={asin}&domain=com",
        "records": all_records
    }
