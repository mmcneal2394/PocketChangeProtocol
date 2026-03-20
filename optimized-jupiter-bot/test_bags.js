const key = "bags_prod_bhNWKWR4_HAseNYlrmgpJX4NklFdCzAbDdYpx9UIIgg";

async function testBags() {
  try {
    const endpoints = [
      "https://public-api-v2.bags.fm/api/v1/tokens",
      "https://public-api-v2.bags.fm/api/v1/explore",
      "https://public-api-v2.bags.fm/api/v1/tokens/trending"
    ];

    for (const url of endpoints) {
      console.log(`Testing ${url}`);
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` } });
      const text = await res.text();
      console.log(`Status: ${res.status}`);
      console.log(`Body slice: ${text.substring(0, 300)}\n`);
    }
  } catch (e) {
    console.error(e);
  }
}
testBags();
