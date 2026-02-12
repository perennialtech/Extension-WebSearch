import {
  getRequestHeaders,
  saveSettingsDebounced,
  substituteParamsExtended,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from "../../../extensions.js";
import { registerDebugFunction } from "../../../power-user.js";
import { SECRET_KEYS, secret_state, writeSecret } from "../../../secrets.js";
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from "../../../popup.js";
import {
  extractTextFromHTML,
  isFalseBoolean,
  isTrueBoolean,
  onlyUnique,
  trimToEndSentence,
  trimToStartSentence,
} from "../../../utils.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";
import {
  ARGUMENT_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument,
} from "../../../slash-commands/SlashCommandArgument.js";
import { commonEnumProviders } from "../../../slash-commands/SlashCommandCommonEnumsProvider.js";
import { localforage } from "../../../../lib.js";

const storage = localforage.createInstance({ name: "SillyTavern_WebSearch" });

const defaultSettings = {
  enabled: false,
  insertionTemplate:
    "***\nRelevant information from the web ({{query}}):\n{{text}}\n***",
  cacheLifetime: 60 * 60 * 24 * 7, // 1 week (seconds)
  budget: 2000,
  visit_count: 3,
  visit_file_header: 'Web search results for "{{query}}"\n\n',
  visit_block_header: "---\nInformation from {{link}}\n\n{{text}}\n\n",
  visit_blacklist: [
    "youtube.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
  ],
  include_images: false,
};

/**
 * Ensures that the provided string ends with a newline.
 * @param {string} text String to ensure an ending newline
 * @returns {string} String with an ending newline
 */
function ensureEndNewline(text) {
  return text.endsWith("\n") ? text : text + "\n";
}

function isSearchAvailable() {
  if (!secret_state[SECRET_KEYS.SERPER]) {
    console.debug("WebSearch: no Serper key found");
    return false;
  }

  return true;
}

/**
 * Checks if the provided link is allowed to be visited or blacklisted.
 * @param {string} link Link to check
 * @returns {boolean} Whether the link is allowed
 */
function isAllowedUrl(link) {
  try {
    const url = new URL(link);
    const isBlacklisted = extension_settings.websearch.visit_blacklist.some(
      (y) => typeof y === "string" && y.trim() && url.hostname.includes(y),
    );
    if (isBlacklisted) {
      console.debug("WebSearch: blacklisted link", link);
    }
    return !isBlacklisted;
  } catch (error) {
    console.debug("WebSearch: invalid link", link);
    return false;
  }
}

/**
 * Formats visit results into a document string with file header and block headers.
 * @param {string} query Search query
 * @param {{link: string, text: string}[]} results Array of visit results
 * @returns {string} Formatted document text, or empty string if no results had text
 */
function formatVisitResults(query, results) {
  let body = "";

  for (const { link, text } of results) {
    if (text) {
      body += ensureEndNewline(
        substituteParamsExtended(
          extension_settings.websearch.visit_block_header,
          { query, text, link },
        ),
      );
    }
  }

  if (!body) {
    return "";
  }

  const fileHeader = ensureEndNewline(
    substituteParamsExtended(extension_settings.websearch.visit_file_header, {
      query,
    }),
  );
  return fileHeader + body;
}

/**
 * Visits the provided web links and extracts the text from the resulting HTML.
 * @param {string} query Search query
 * @param {string[]} links Array of links to visit
 * @returns {Promise<string>} Formatted document text
 */
async function visitLinks(query, links) {
  if (!Array.isArray(links) || links.length === 0) {
    console.debug("WebSearch: no links to visit");
    return "";
  }

  const visitCount = extension_settings.websearch.visit_count;
  const results = await collectVisitResults(links, visitCount);
  const text = formatVisitResults(query, results);

  if (!text) {
    console.debug("WebSearch: no text to attach");
  }

  return text;
}

/**
 * Visits the provided web link and extracts the text from the resulting HTML.
 * @param {string} link Web link to visit
 * @returns {Promise<{link: string, text:string}>} Extracted text
 */
async function visitLink(link) {
  try {
    const result = await fetch("/api/search/visit", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({ url: link, html: true }),
    });

    if (!result.ok) {
      console.debug(
        `WebSearch: visit request failed with status ${result.statusText}`,
        link,
      );
      return;
    }

    const data = await result.blob();
    const text = await extractTextFromHTML(data, "p"); // Only extract text from <p> tags
    console.debug("WebSearch: visit result", link, text);
    return { link, text };
  } catch (error) {
    console.error("WebSearch: visit failed", error);
  }
}

/**
 * Visits allowed links sequentially and collects results.
 * @param {string[]} links Array of links to visit
 * @param {number} [maxCount=Infinity] Maximum number of links to visit
 * @returns {Promise<{link: string, text: string}[]>} Array of visit results
 */
async function collectVisitResults(links, maxCount = Infinity) {
  const results = [];
  for (const link of links) {
    if (results.length >= maxCount) break;
    if (!isAllowedUrl(link)) continue;
    const result = await visitLink(link);
    if (result) results.push(result);
  }
  return results;
}

/**
 * Performs a search query via Serper.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[], images: string[]}>} Extracted text
 */
async function doSerperQuery(query) {
  const emptyResult = { textBits: [], links: [], images: [] };
  const includeImages = extension_settings.websearch.include_images;

  // Run web search and (optionally) image search in parallel
  const webSearchPromise = fetch("/api/search/serper", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ query }),
  });

  const imageSearchPromise = includeImages
    ? fetch("/api/search/serper", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ query, images: true }),
      })
    : Promise.resolve(null);

  const [webResponse, imageResponse] = await Promise.allSettled([
    webSearchPromise,
    imageSearchPromise,
  ]);

  // Parse web search results
  const textBits = [];
  const links = [];
  const images = [];

  if (webResponse.status === "fulfilled" && webResponse.value?.ok) {
    const data = await webResponse.value.json();

    if (data.answerBox) {
      textBits.push(`${data.answerBox.title} ${data.answerBox.answer}`);
    }

    if (data.knowledgeGraph) {
      textBits.push(`${data.knowledgeGraph.title} ${data.knowledgeGraph.type}`);
      for (const [key, value] of Object.entries(
        data.knowledgeGraph.attributes ?? {},
      )) {
        textBits.push(`${key}: ${value}`);
      }
    }

    if (Array.isArray(data.organic)) {
      textBits.push(...data.organic.map((x) => x.snippet));
      links.push(...data.organic.map((x) => x.link));
    }

    if (Array.isArray(data.peopleAlsoAsk)) {
      textBits.push(
        ...data.peopleAlsoAsk.map((x) => `${x.question} ${x.snippet}`),
      );
      links.push(...data.peopleAlsoAsk.map((x) => x.link));
    }

    if (Array.isArray(data.images) && includeImages) {
      images.push(...data.images.map((x) => x.imageUrl));
    }
  } else {
    const reason =
      webResponse.status === "rejected"
        ? webResponse.reason
        : webResponse.value?.statusText;
    console.debug("WebSearch: web search request failed", reason);
  }

  // Parse image search results
  if (imageResponse?.status === "fulfilled" && imageResponse.value?.ok) {
    const data = await imageResponse.value.json();
    if (Array.isArray(data.images)) {
      images.push(...data.images.map((x) => x.imageUrl));
    }
  } else if (includeImages && imageResponse) {
    const reason =
      imageResponse.status === "rejected"
        ? imageResponse.reason
        : imageResponse.value?.statusText;
    console.debug("WebSearch: image search request failed", reason);
  }

  if (textBits.length === 0 && links.length === 0 && images.length === 0) {
    return emptyResult;
  }

  return { textBits, links, images };
}

/**
 *
 * @param {string} query Search query
 * @param {SearchRequestOptions} options Search request options
 * @typedef {{useCache?: boolean}} SearchRequestOptions
 * @returns {Promise<{text:string, links: string[], images: string[]}>} Extracted text
 */
async function performSearchRequest(query, options = {}) {
  const useCache = options?.useCache ?? true;

  // Check if the query is cached
  if (useCache) {
    const cacheKey = `query_${query}`;
    const cacheLifetime = extension_settings.websearch.cacheLifetime;
    const cachedResult = await storage.getItem(cacheKey);

    if (cachedResult) {
      console.debug("WebSearch: cached result found", cachedResult);
      // Check if the cache is expired
      if (cachedResult.timestamp + cacheLifetime * 1000 < Date.now()) {
        console.debug("WebSearch: cached result is expired, requerying");
        await storage.removeItem(cacheKey);
      } else {
        console.debug("WebSearch: cached result is valid");
        return {
          text: cachedResult.text,
          links: cachedResult.links,
          images: cachedResult.images,
        };
      }
    }
  }

  let searchResult;
  try {
    searchResult = await doSerperQuery(query);
  } catch (error) {
    console.error("WebSearch: search failed", error);
    searchResult = { textBits: [], links: [], images: [] };
  }

  const { textBits } = searchResult;
  const links = searchResult.links.filter(onlyUnique);
  const images = searchResult.images.filter(onlyUnique);
  const budget = extension_settings.websearch.budget;
  let text = "";

  // Assemble text while respecting the budget strictly.
  for (let snippet of textBits.filter(onlyUnique)) {
    if (!snippet) continue;

    // Incomplete sentences confuse the model, so we trim them
    if (snippet.endsWith("...")) {
      snippet = trimToEndSentence(snippet.slice(0, -3)).trim();
    }
    if (snippet.startsWith("...")) {
      snippet = trimToStartSentence(snippet.slice(3)).trim();
    }

    if (!snippet) continue;
    if (text.length >= budget) break;

    const remaining = budget - text.length;
    let toAdd = snippet;

    // +1 for the newline we append after each snippet
    if (toAdd.length + 1 > remaining) {
      const room = Math.max(0, remaining - 1);
      toAdd = toAdd.slice(0, room);
      toAdd = trimToEndSentence(toAdd).trim();
    }

    if (!toAdd) continue;

    text += toAdd + "\n";
  }

  if (!text) {
    console.debug("WebSearch: search produced no text");
    return { text: "", links: [], images: [] };
  }

  console.log(
    `WebSearch: extracted text (length = ${text.length}, budget = ${budget})`,
    text,
  );

  // Save the result to cache
  if (useCache) {
    await storage.setItem(`query_${query}`, {
      text,
      links,
      images,
      timestamp: Date.now(),
    });
  }

  return { text, links, images };
}

/**
 * Provides an interface for the Data Bank to interact with the extension.
 */
class WebSearchScraper {
  constructor() {
    this.id = "websearch";
    this.name = "Web Search";
    this.description = "Perform a web search and download the results.";
    this.iconClass = "fa-solid fa-search";
    this.iconAvailable = true;
  }

  /**
   * Check if the scraper is available.
   * @returns {boolean} Whether the scraper is available
   */
  isAvailable() {
    return isSearchAvailable();
  }

  /**
   * Scrape file attachments from a webpage.
   * @returns {Promise<File[]>} File attachments scraped from the webpage
   */
  async scrape() {
    try {
      const template = $(
        await renderExtensionTemplateAsync(
          "third-party/Extension-WebSearch",
          "search-scrape",
          {},
        ),
      );
      let query = "";
      let maxResults = extension_settings.websearch.visit_count;
      let output = "multi";
      let snippets = false;
      template.find('input[name="searchScrapeQuery"]').on("input", function () {
        query = String($(this).val());
      });
      template
        .find('input[name="searchScrapeMaxResults"]')
        .val(maxResults)
        .on("input", function () {
          maxResults = Number($(this).val());
        });
      template
        .find('input[name="searchScrapeOutput"]')
        .on("input", function () {
          output = String($(this).val());
        });
      template
        .find('input[name="searchScrapeSnippets"]')
        .on("change", function () {
          snippets = $(this).prop("checked");
        });

      const confirm = await callGenericPopup(template, POPUP_TYPE.CONFIRM, "", {
        okButton: "Scrape",
        cancelButton: "Cancel",
      });

      if (!confirm) {
        return;
      }

      if (!this.isAvailable()) {
        toastr.warning(
          "Serper API key is not set. Go to Extensions > Web Search to configure it.",
        );
        return [];
      }

      const toast = toastr.info("Working, please wait...");
      const searchResult = await performSearchRequest(query, {
        useCache: false,
      });

      if (
        !Array.isArray(searchResult?.links) ||
        searchResult.links.length === 0
      ) {
        console.debug("WebSearch: no links to scrape");
        toastr.clear(toast);
        return [];
      }

      const visitResults = await collectVisitResults(
        searchResult.links,
        maxResults,
      );

      const files = [];

      if (snippets) {
        const fileName = `snippets - ${query} - ${Date.now()}.txt`;
        const file = new File([searchResult.text], fileName, {
          type: "text/plain",
        });
        files.push(file);
      }

      if (output === "single") {
        const fileText = formatVisitResults(query, visitResults);
        if (fileText) {
          const fileName = `websearch - ${query} - ${Date.now()}.txt`;
          const file = new File([fileText], fileName, { type: "text/plain" });
          files.push(file);
        }
      }

      if (output === "multi") {
        for (const result of visitResults) {
          if (result.text) {
            const domain = new URL(result.link).hostname;
            const fileName = `${query} - ${domain} - ${Date.now()}.txt`;
            const file = new File([result.text], fileName, {
              type: "text/plain",
            });
            files.push(file);
          }
        }
      }

      toastr.clear(toast);
      return files;
    } catch (error) {
      console.error("WebSearch: error while scraping", error);
    }
  }
}

function registerFunctionTools() {
  try {
    const { registerFunctionTool, unregisterFunctionTool } =
      SillyTavern.getContext();

    if (!registerFunctionTool || !unregisterFunctionTool) {
      console.log("WebSearch: Function tools are not supported");
      return;
    }

    if (!extension_settings.websearch.enabled) {
      unregisterFunctionTool("WebSearch");
      unregisterFunctionTool("VisitLinks");
      return;
    }

    const webSearchSchema = Object.freeze({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Web Query used in search engine.",
        },
      },
      required: ["query"],
    });

    const visitLinksSchema = Object.freeze({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: {
        links: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Web links to visit.",
        },
      },
      required: ["links"],
    });

    registerFunctionTool({
      name: "WebSearch",
      displayName: "Web Search",
      description:
        "Search the web and get the content of the relevant pages. Search for unknown knowledge, public personalities, up-to-date information, weather, news, etc.",
      parameters: webSearchSchema,
      formatMessage: (args) =>
        args?.query ? `Searching the web for: ${args?.query}` : "",
      action: async (args) => {
        if (!args) throw new Error("No arguments provided");
        if (!args.query) throw new Error("No query provided");
        if (!isSearchAvailable()) throw new Error("Search is not available");
        const search = await performSearchRequest(args.query, {
          useCache: true,
        });
        return search;
      },
    });

    registerFunctionTool({
      name: "VisitLinks",
      displayName: "Visit Links",
      description:
        "Visit the web links and get the content of the relevant pages.",
      parameters: visitLinksSchema,
      formatMessage: (args) => (args?.links ? "Visiting the web links" : ""),
      action: async (args) => {
        if (!args) throw new Error("No arguments provided");
        if (!args.links) throw new Error("No links provided");
        // Visiting links does not require Serper key
        const max = extension_settings.websearch.visit_count;
        return collectVisitResults(args.links, max);
      },
    });
  } catch (error) {
    console.error("WebSearch: Function tools failed to register:", error);
  }
}

/**
 * Manages API key storage and UI updates for the Serper service
 * @param {JQuery} buttonElement - jQuery button element reference
 */
async function handleSerperKeyManagement(buttonElement) {
  const key = await callGenericPopup("Add a Serper key", POPUP_TYPE.INPUT, "", {
    rows: 2,
    customButtons: [
      {
        text: "Remove Key",
        appendAtEnd: true,
        result: POPUP_RESULT.NEGATIVE,
        action: async () => {
          await writeSecret(SECRET_KEYS.SERPER, "");
          buttonElement.toggleClass(
            "success",
            !!secret_state[SECRET_KEYS.SERPER],
          );
          toastr.success("API Key removed");
        },
      },
    ],
  });

  if (key) {
    await writeSecret(SECRET_KEYS.SERPER, String(key).trim());
    toastr.success("API Key saved");
  }

  buttonElement.toggleClass("success", !!secret_state[SECRET_KEYS.SERPER]);
}

jQuery(async () => {
  if (!extension_settings.websearch) {
    extension_settings.websearch = structuredClone(defaultSettings);
  }

  for (const key of Object.keys(defaultSettings)) {
    if (extension_settings.websearch[key] === undefined) {
      extension_settings.websearch[key] = defaultSettings[key];
    }
  }

  const html = await renderExtensionTemplateAsync(
    "third-party/Extension-WebSearch",
    "settings",
  );

  const getContainer = () =>
    $(
      document.getElementById("websearch_container") ??
        document.getElementById("extensions_settings2"),
    );
  getContainer().append(html);
  $("#websearch_enabled").prop(
    "checked",
    !!extension_settings.websearch.enabled,
  );
  $("#websearch_enabled").on("change", () => {
    extension_settings.websearch.enabled =
      !!$("#websearch_enabled").prop("checked");
    registerFunctionTools();
    saveSettingsDebounced();
  });
  $("#serper_key").on("click", async () => {
    await handleSerperKeyManagement($("#serper_key"));
  });
  $("#serper_key").toggleClass("success", !!secret_state[SECRET_KEYS.SERPER]);
  $("#websearch_budget").val(extension_settings.websearch.budget);
  $("#websearch_budget").on("input", () => {
    extension_settings.websearch.budget = Number($("#websearch_budget").val());
    saveSettingsDebounced();
  });
  $("#websearch_cache_lifetime").val(
    extension_settings.websearch.cacheLifetime,
  );
  $("#websearch_cache_lifetime").on("input", () => {
    extension_settings.websearch.cacheLifetime = Number(
      $("#websearch_cache_lifetime").val(),
    );
    saveSettingsDebounced();
  });
  $("#websearch_template").val(extension_settings.websearch.insertionTemplate);
  $("#websearch_template").on("input", () => {
    extension_settings.websearch.insertionTemplate = String(
      $("#websearch_template").val(),
    );
    saveSettingsDebounced();
  });
  $("#websearch_visit_count").val(extension_settings.websearch.visit_count);
  $("#websearch_visit_count").on("input", () => {
    extension_settings.websearch.visit_count = Number(
      $("#websearch_visit_count").val(),
    );
    saveSettingsDebounced();
  });
  $("#websearch_visit_blacklist").val(
    extension_settings.websearch.visit_blacklist.join("\n"),
  );
  $("#websearch_visit_blacklist").on("input", () => {
    extension_settings.websearch.visit_blacklist = String(
      $("#websearch_visit_blacklist").val(),
    )
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    saveSettingsDebounced();
  });
  $("#websearch_file_header").val(
    extension_settings.websearch.visit_file_header,
  );
  $("#websearch_file_header").on("input", () => {
    extension_settings.websearch.visit_file_header = String(
      $("#websearch_file_header").val(),
    );
    saveSettingsDebounced();
  });
  $("#websearch_block_header").val(
    extension_settings.websearch.visit_block_header,
  );
  $("#websearch_block_header").on("input", () => {
    extension_settings.websearch.visit_block_header = String(
      $("#websearch_block_header").val(),
    );
    saveSettingsDebounced();
  });
  $("#websearch_include_images").prop(
    "checked",
    extension_settings.websearch.include_images,
  );
  $("#websearch_include_images").on("change", () => {
    extension_settings.websearch.include_images = !!$(
      "#websearch_include_images",
    ).prop("checked");
    saveSettingsDebounced();
  });

  registerFunctionTools();

  registerDebugFunction(
    "clearWebSearchCache",
    "Clear the WebSearch cache",
    "Removes all search results stored in the local cache.",
    async () => {
      await storage.clear();
      console.log("WebSearch: cache cleared");
      toastr.success("WebSearch: cache cleared");
    },
  );

  registerDebugFunction(
    "testWebSearch",
    "Test the WebSearch extension",
    "Performs a test search using the current settings.",
    async () => {
      try {
        const text = prompt("Enter a test message", "How to make a sandwich");

        if (!text) {
          return;
        }

        const result = await performSearchRequest(text, { useCache: false });
        console.log("WebSearch: test result", text, result.text, result.links);
        alert(result.text);
      } catch (error) {
        toastr.error(String(error), "WebSearch: test failed");
      }
    },
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: "websearch",
      helpString:
        "Performs a web search query. Use named arguments to specify what to return - page snippets, full parsed pages, or both.",
      unnamedArgumentList: [
        SlashCommandArgument.fromProps({
          description: "query",
          typeList: [ARGUMENT_TYPE.STRING],
          isRequired: true,
          acceptsMultiple: false,
        }),
      ],
      namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
          name: "snippets",
          description: "Include page snippets",
          typeList: [ARGUMENT_TYPE.BOOLEAN],
          isRequired: false,
          acceptsMultiple: false,
          defaultValue: String(true),
          forceEnum: true,
          enumProvider: commonEnumProviders.boolean("trueFalse"),
        }),
        SlashCommandNamedArgument.fromProps({
          name: "links",
          description: "Include full parsed pages",
          typeList: [ARGUMENT_TYPE.BOOLEAN],
          isRequired: false,
          acceptsMultiple: false,
          defaultValue: String(false),
          forceEnum: true,
          enumProvider: commonEnumProviders.boolean("trueFalse"),
        }),
      ],
      callback: async (args, query) => {
        const includeSnippets = !isFalseBoolean(String(args.snippets));
        const includeLinks = isTrueBoolean(String(args.links));

        if (!query) {
          toastr.warning("No search query specified");
          return "";
        }

        if (!includeSnippets && !includeLinks) {
          toastr.warning("No search result type specified");
          return "";
        }

        if (!isSearchAvailable()) {
          toastr.warning(
            "WebSearch is not configured. Set a Serper API key in Extensions > Web Search.",
          );
          return "";
        }

        const result = await performSearchRequest(String(query), {
          useCache: true,
        });

        let output = includeSnippets ? result.text : "";

        if (
          includeLinks &&
          Array.isArray(result.links) &&
          result.links.length > 0
        ) {
          const visitResult = await visitLinks(String(query), result.links);
          output += (output ? "\n" : "") + visitResult;
        }

        return output;
      },
    }),
  );

  const context = getContext();
  if (typeof context.registerDataBankScraper === "function") {
    context.registerDataBankScraper(new WebSearchScraper());
  }
});
