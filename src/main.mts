import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";
// --- constants & types ---
export const PAGE = 1000; // The Graph caps page size at 1 000
/**
 * Uniswap-V2 subgraph on Base
 * Deployment ID: CStW6CSQbHoXsgKuVCrk3uShGA4JX3CAzzv2x9zaGf8w
 */
export function endpoint(apiKey?: string): string {
  if (!apiKey || apiKey === "dummy") {
    return "https://gateway.thegraph.com/api/[api-key]/subgraphs/id/CStW6CSQbHoXsgKuVCrk3uShGA4JX3CAzzv2x9zaGf8w";
  }
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/CStW6CSQbHoXsgKuVCrk3uShGA4JX3CAzzv2x9zaGf8w`;
}

// --- types ---
interface Token {
  id: string;
  name: string;
  symbol: string;
}

interface Pair {
  id: string;
  createdAtTimestamp: number;
  token0: Token;
  token1: Token;
}

interface GraphQLData {
  pairs: Pair[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[];
}

// --- query ---
const PAIR_QUERY = `
  query GetPools($lastTimestamp: Int) {
    pairs(
      first: 1000,
      orderBy: createdAtTimestamp,
      orderDirection: asc,
      where: { createdAtTimestamp_gt: $lastTimestamp }
    ) {
      id
      createdAtTimestamp
      token0 {
        id
        name
        symbol
      }
      token1 {
        id
        name
        symbol
      }
    }
  }
`;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

function containsHtmlOrMarkdown(text: string): boolean {
  return /<[^>]+>/.test(text);
}

function isError(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as Error).message === "string"
  );
}

function truncateString(text: string, maxLength: number) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength - 3) + "...";
  }
  return text;
}

// --- utils ---
/** Decode 32-byte hex (with/without 0x) → printable ASCII, strip junk */
export function cleanSymbol(raw: string): string {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    raw = Buffer.from(hex, "hex")
      .toString("utf8")
      .replace(/\u0000/g, "");
  }
  const txt = raw.replace(/[^\u0002-\u007f]/g, "").trim(); // printable ASCII
  return txt.length >= 2 && txt.length <= 32 ? txt : "";
}
/**
 * Transform pools into ContractTag objects, applying policy and field validation.
 */
function transformPairsToTags(chainId: string, pairs: Pair[]): ContractTag[] {
  // First, filter and log invalid entries
  const validPairs: Pair[] = [];
  const rejectedNames: string[] = [];

  pairs.forEach((pair) => {
    const token0Invalid =
      containsHtmlOrMarkdown(pair.token0.name) ||
      containsHtmlOrMarkdown(pair.token0.symbol);
    const token1Invalid =
      containsHtmlOrMarkdown(pair.token1.name) ||
      containsHtmlOrMarkdown(pair.token1.symbol);

    if (token0Invalid || token1Invalid) {
      if (token0Invalid) {
        rejectedNames.push(
          pair.token0.name + ", Symbol: " + pair.token0.symbol
        );
      }
      if (token1Invalid) {
        rejectedNames.push(
          pair.token1.name + ", Symbol: " + pair.token1.symbol
        );
      }
    } else {
      validPairs.push(pair);
    }
  });

  // Log all rejected names
  if (rejectedNames.length > 0) {
    console.log(
      "Rejected token names due to HTML/Markdown content:",
      rejectedNames
    );
  }

  // Process valid pair into tags
  return validPairs.map((pair) => {
    const maxSymbolsLength = 45;
    const symbolsText = `${pair.token0.symbol.trim()}/${pair.token1.symbol.trim()}`;
    const truncatedSymbolsText = truncateString(symbolsText, maxSymbolsLength);

    return {
      "Contract Address": `eip155:${chainId}:${pair.id}`,
      "Public Name Tag": `${truncatedSymbolsText} Pair`,
      "Project Name": "Uniswap v2",
      "UI/Website Link": "https://uniswap.org",
      "Public Note": `The Uniswap v2 contract for the ${pair.token0.name.replace("USD//C", "USDC").trim()} (${pair.token0.symbol.trim()}) / ${pair.token1.name.replace("USD//C", "USDC").trim()} (${pair.token1.symbol.trim()}) pair.`,
    };
  });
}


// --- main logic ---
interface GraphResponse<T> {
  data: T;
  errors?: unknown;
}

async function fetchPairs(apiKey: string, lastTimestamp: number): Promise<Pair[]> {
  const resp = await fetch(endpoint(apiKey), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: PAIR_QUERY, variables: { lastTimestamp } }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP error: ${resp.status}`);
  }
  const json = (await resp.json()) as GraphQLResponse;
  if (json.errors) {
    json.errors.forEach((error) => {
      console.error(`GraphQL error: ${error.message}`);
    });
    throw new Error("GraphQL errors occurred: see logs for details.");
  }
  if (!json.data || !json.data.pairs) {
    throw new Error("No pairs data found.");
  }
  return json.data.pairs;
}


class TagService implements ITagService {
  returnTags = async (
    chainId: string,
    apiKey: string
  ): Promise<ContractTag[]> => {
    if (Number(chainId) !== 42161)
      throw new Error(`Unsupported Chain ID: ${chainId}.`);
    if (!apiKey) throw new Error("API key is required");
    let lastTimestamp: number = 0;
    let allTags: ContractTag[] = [];
    let isMore = true;
    let counter = 0;
    const seenAddr = new Set<string>();
    while (isMore) {
      let pairs: Pair[];
      try {
        pairs = await fetchPairs(apiKey, lastTimestamp);
        const tagsForPairs = transformPairsToTags(chainId, pairs).filter(tag => {
          // Ensure unique contract address
          if (seenAddr.has(tag["Contract Address"])) return false;
          seenAddr.add(tag["Contract Address"]);
          return true;
        });
        allTags.push(...tagsForPairs);
        counter++;
        console.log(`Retrieved first ${counter * 1000} entries...`);
        isMore = pairs.length === 1000;
        if (isMore) {
          lastTimestamp = parseInt(
            pairs[pairs.length - 1].createdAtTimestamp.toString(),
            10
          );
        }
      } catch (error) {
        if (isError(error)) {
          console.error(`An error occurred: ${error.message}`);
          throw new Error(`Failed fetching data: ${error}`);
        } else {
          console.error("An unknown error occurred.");
          throw new Error("An unknown error occurred during fetch operation.");
        }
      }
    }
    return allTags;
  };
}

const tagService = new TagService();
export const returnTags = tagService.returnTags;
