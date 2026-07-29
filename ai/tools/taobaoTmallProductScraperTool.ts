import { callApifyActor } from "./apifyActorClient";

export const taobaoTmallProductScraperFunctionSchema = {
  name: "taobaoTmallProductScraper",
  description:
    "使用 Apify Taobao/Tmall Product Scraper 获取淘宝/天猫商品真实详情，返回标题、价格、SKU、库存、图片、店铺、属性和规格参数。适合用户提供淘宝/天猫链接或商品 ID 后做真实参数对比。",
  parameters: {
    type: "object",
    properties: {
      itemId: {
        type: "string",
        description:
          "淘宝/天猫数字商品 ID。可从链接中的 id 参数提取，例如 https://item.taobao.com/item.htm?id=744983869996。",
      },
      detailDepth: {
        type: "string",
        enum: ["lite", "standard", "full"],
        description:
          "详情深度。full 会尽量返回优惠后价格、属性、规格、SKU 和促销信息；默认 full。",
        default: "full",
      },
    },
    required: ["itemId"],
  },
};

export async function taobaoTmallProductScraperFunc(
  args: {
    itemId: string;
    detailDepth?: "lite" | "standard" | "full";
  },
  thunkApi: any
) {
  const itemId = String(args.itemId ?? "").trim();
  if (!/^\d{6,}$/.test(itemId)) {
    throw new Error("淘宝/天猫商品详情抓取失败：itemId 必须是有效的数字商品 ID。");
  }

  return callApifyActor(thunkApi, {
    actorId: "sian.agency~taobao-tmall-product-scraper",
    input: {
      operation: "productDetail",
      itemId,
      detailDepth: args.detailDepth ?? "full",
    },
    resultType: "datasetItems",
    displayName: "Taobao/Tmall Product Scraper",
  });
}
