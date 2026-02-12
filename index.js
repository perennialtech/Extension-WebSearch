import {
  appendMediaToMessage,
  extension_prompt_types,
  getRequestHeaders,
  saveSettingsDebounced,
  substituteParamsExtended,
  name2,
} from "../../../../script.js";
import { appendFileContent, uploadFileAttachment } from "../../../chats.js";
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
  getStringHash,
  isDataURL,
  bufferToBase64,
  saveBase64AsFile,
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

const { ensureMessageMediaIsArray } = SillyTavern.getContext();
const supportsMediaArrays = typeof ensureMessageMediaIsArray === "function";

const storage = localforage.createInstance({ name: "SillyTavern_WebSearch" });

const VISIT_TARGETS = {
  MESSAGE: 0,
  DATA_BANK: 1,
  NONE: 2,
};

const defaultSettings = {
  insertionTemplate:
    "***\nRelevant information from the web ({{query}}):\n{{text}}\n***",
  cacheLifetime: 60 * 60 * 24 * 7, // 1 week
  budget: 2000,
  visit_enabled: false,
  visit_target: VISIT_TARGETS.MESSAGE,
  visit_count: 3,
  visit_file_header: 'Web search results for "{{query}}"\n\n',
  visit_block_header: "---\nInformation from {{link}}\n\n{{text}}\n\n",
  visit_blacklist: [
    "youtube.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
  ],
  use_function_tool: true,
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

async function isSearchAvailable() {
  if (!secret_state[SECRET_KEYS.SERPER]) {
    console.debug("WebSearch: no Serper key found");
    return false;
  }

  return true;
}

/**
 * Determines whether the function tool can be used.
 * @returns {boolean} Whether the function tool can be used
 */
function canUseFunctionTool() {
  const { isToolCallingSupported } = SillyTavern.getContext();
  if (typeof isToolCallingSupported !== "function") {
    console.debug("WebSearch: tool calling is not supported");
    return false;
  }

  return isToolCallingSupported();
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
 * Visits the provided web links and extracts the text from the resulting HTML.
 * @param {string} query Search query
 * @param {string[]} links Array of links to visit
 * @returns {Promise<string>} Extracted text
 */
async function visitLinks(query, links) {
  if (!Array.isArray(links)) {
    console.debug("WebSearch: not an array of links");
    return "";
  }

  links = links.filter(isAllowedUrl);

  if (links.length === 0) {
    console.debug("WebSearch: no links to visit");
    return "";
  }

  const visitCount = extension_settings.websearch.visit_count;
  const visitPromises = [];

  for (let i = 0; i < Math.min(visitCount, links.length); i++) {
    const link = links[i];
    visitPromises.push(visitLink(link));
  }

  const visitResult = await Promise.allSettled(visitPromises);

  let linkResult = "";

  for (const result of visitResult) {
    if (result.status === "fulfilled" && result.value) {
      const { link, text } = result.value;

      if (text) {
        linkResult += ensureEndNewline(
          substituteParamsExtended(
            extension_settings.websearch.visit_block_header,
            { query: query, text: text, link: link },
          ),
        );
      }
    }
  }

  if (!linkResult) {
    console.debug("WebSearch: no text to attach");
    return "";
  }

  const fileHeader = ensureEndNewline(
    substituteParamsExtended(extension_settings.websearch.visit_file_header, {
      query: query,
    }),
  );
  const fileText = fileHeader + linkResult;
  return fileText;
}

/**
 * Visit the provided image links and attach the resulting files to the chat.
 * @param {string[]} images Array of image URLs
 * @returns {Promise<string[]>} Resulting image URLs
 */
async function visitImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    console.debug("WebSearch: no images to visit");
    return [];
  }

  const imageSwipes = [];
  const visitPromises = [];
  const visitCount = extension_settings.websearch.visit_count;

  for (let i = 0; i < Math.min(visitCount, images.length); i++) {
    const image = images[i];
    visitPromises.push(visitImage(image));
  }

  const visitResult = await Promise.allSettled(visitPromises);

  for (const result of visitResult) {
    if (result.status === "fulfilled" && result.value) {
      const image = result.value;
      if (image) {
        imageSwipes.push(image);
      }
    }
  }

  return imageSwipes;
}

/**
 * Checks if the file for the search query already exists in the Data Bank.
 * @param {string} query Search query
 * @returns {Promise<boolean>} Whether the file exists
 */
async function isFileExistsInDataBank(query) {
  try {
    const { getDataBankAttachmentsForSource } = await import(
      "../../../chats.js"
    );
    const attachments = await getDataBankAttachmentsForSource("chat");
    const existingAttachment = attachments.find((x) =>
      x.name.startsWith(`websearch - ${query} - `),
    );
    if (existingAttachment) {
      console.debug(
        "WebSearch: file for such query already exists in the Data Bank",
      );
      return true;
    }
    return false;
  } catch (error) {
    // Prevent visiting links if the Data Bank is not available
    toastr.error("Data Bank module is not available");
    console.error(
      "WebSearch: failed to check if the file exists in the Data Bank",
      error,
    );
    return true;
  }
}

/**
 * Uploads the file to the Data Bank.
 * @param {string} fileName File name
 * @param {string} fileText File text
 * @returns {Promise<void>}
 */
async function uploadToDataBank(fileName, fileText) {
  try {
    const { uploadFileAttachmentToServer } = await import("../../../chats.js");
    const file = new File([fileText], fileName, { type: "text/plain" });
    await uploadFileAttachmentToServer(file, "chat");
  } catch (error) {
    console.error("WebSearch: failed to import the chat module", error);
  }
}

/**
 * Visits the provided web links and attaches the resulting text to the chat as a file.
 * @param {string} query Search query
 * @param {string[]} links Web links to visit
 * @param {string[]} images Image links to visit
 * @param {number} messageId Message ID that triggered the search
 * @returns {Promise<{fileContent: string, file: object}>} File content and file object
 */
async function visitLinksAndAttachToMessage(query, links, images, messageId) {
  if (isNaN(messageId)) {
    console.debug("WebSearch: invalid message ID");
    return;
  }

  const context = getContext();
  const message = context.chat[messageId];
  const updateMessageMedia = () => {
    const messageElement = $(`.mes[mesid="${messageId}"]`);

    if (messageElement.length === 0) {
      console.debug("WebSearch: failed to find the message element");
      return;
    }

    appendMediaToMessage(message, messageElement);
  };

  if (!message) {
    console.debug("WebSearch: failed to find the message");
    return;
  }

  if (!message.extra || typeof message.extra !== "object") {
    message.extra = {};
  }

  if (
    extension_settings.websearch.include_images &&
    Array.isArray(images) &&
    images.length > 0
  ) {
    try {
      if (!supportsMediaArrays) {
        const hasImage = Boolean(message.extra.image);
        const hasImageSwipes =
          Array.isArray(message.extra.image_swipes) &&
          message.extra.image_swipes.length > 0;
        if (!hasImage && !hasImageSwipes) {
          const imageLinks = await visitImages(images);
          if (imageLinks.length > 0) {
            message.extra.title = query;
            message.extra.image = imageLinks[0];
            message.extra.image_swipes = imageLinks;
            message.extra.inline_image = true;
          }
        }
      }
      if (supportsMediaArrays) {
        const hasMedia =
          Array.isArray(message.extra.media) && message.extra.media.length > 0;
        if (!hasMedia) {
          const imageLinks = await visitImages(images);
          if (imageLinks.length > 0) {
            message.extra.media = imageLinks.map((url) => ({
              url: url,
              type: "image",
              title: query,
            }));
            message.extra.media_index = 0;
            message.extra.media_display = "gallery";
            message.extra.inline_image = true;
          }
        }
      }
      updateMessageMedia();
    } catch (error) {
      console.error("WebSearch: failed to attach images", error);
    }
  }

  if (extension_settings.websearch.visit_target === VISIT_TARGETS.NONE) {
    console.debug("WebSearch: visit target is set to none");
    return;
  }

  if (!supportsMediaArrays && message.extra.file) {
    console.debug("WebSearch: message already has a file attachment");
    return;
  }

  if (
    supportsMediaArrays &&
    Array.isArray(message.extra.files) &&
    message.extra.files.length > 0
  ) {
    console.debug("WebSearch: message already has file attachments");
    return;
  }

  try {
    if (extension_settings.websearch.visit_target === VISIT_TARGETS.DATA_BANK) {
      const fileExists = await isFileExistsInDataBank(query);

      if (fileExists) {
        return;
      }
    }

    const fileName = `websearch - ${query} - ${Date.now()}.txt`;
    const fileText = await visitLinks(query, links);

    if (!fileText) {
      return;
    }

    if (extension_settings.websearch.visit_target === VISIT_TARGETS.DATA_BANK) {
      await uploadToDataBank(fileName, fileText);
    } else {
      const base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
      const uniqueFileName = `${Date.now()}_${getStringHash(fileName)}.txt`;
      const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);

      if (!fileUrl) {
        console.debug("WebSearch: failed to upload the file");
        return;
      }

      const file = {
        url: fileUrl,
        size: fileText.length,
        name: fileName,
      };

      if (supportsMediaArrays) {
        if (!Array.isArray(message.extra.files)) {
          message.extra.files = [];
        }
        message.extra.files.push(file);
      } else {
        message.extra.file = file;
      }

      updateMessageMedia();
      return { fileContent: fileText, file: file };
    }
  } catch (error) {
    console.error("WebSearch: failed to attach the file", error);
  }
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
 * Visits the provided web link and extracts the data as a Blob.
 * @param {string} url URL to visit
 * @returns {Promise<Blob>} Extracted data
 */
async function visitBlobUrl(url) {
  try {
    // Directly download the data URL
    if (isDataURL(url)) {
      const data = await fetch(url);
      return await data.blob();
    }

    const result = await fetch("/api/search/visit", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({ url: url, html: false }),
    });

    if (!result.ok) {
      console.debug(
        `WebSearch: visit request failed with status ${result.statusText}`,
        url,
      );
      return;
    }

    const data = await result.blob();
    return data;
  } catch (error) {
    console.error("WebSearch: visit blob failed", error);
    return null;
  }
}

/**
 * Download and save the provided image URL as a local file.
 * @param {string} url Image URL
 * @returns {Promise<string>} Link to local image
 */
async function visitImage(url) {
  try {
    const data = await visitBlobUrl(url);
    if (!data) {
      return null;
    }
    const base64Data = await bufferToBase64(data);
    const extension = data.type?.split("/")?.[1] || "jpeg";
    return await saveBase64AsFile(
      base64Data,
      name2,
      `search-result-${Date.now()}`,
      extension,
    );
  } catch (error) {
    console.error("WebSearch: image scraping failed", error);
    return null;
  }
}

/**
 * Performs a search query via Serper.
 * @param {string} query Search query
 * @returns {Promise<{textBits: string[], links: string[], images: string[]}>} Extracted text
 */
async function doSerperQuery(query) {
  const textBits = [];
  const links = [];
  const images = [];

  async function searchWeb() {
    const result = await fetch("/api/search/serper", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({ query }),
    });

    if (!result.ok) {
      console.debug("WebSearch: search request failed", result.statusText);
      return;
    }

    const data = await result.json();
    if (data.answerBox) {
      textBits.push(`${data.answerBox.title} ${data.answerBox.answer}`);
    }

    if (data.knowledgeGraph) {
      textBits.push(`${data.knowledgeGraph.title} ${data.knowledgeGraph.type}`);
      Object.entries(data.knowledgeGraph.attributes ?? {}).forEach(
        ([key, value]) => {
          textBits.push(`${key}: ${value}`);
        },
      );
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

    if (
      Array.isArray(data.images) &&
      extension_settings.websearch.include_images
    ) {
      images.push(...data.images.map((x) => x.imageUrl));
    }
  }

  async function searchImages() {
    if (!extension_settings.websearch.include_images) {
      return;
    }

    const result = await fetch("/api/search/serper", {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({ query, images: true }),
    });

    if (!result.ok) {
      console.debug("WebSearch: search request failed", result.statusText);
      return;
    }

    const data = await result.json();
    if (Array.isArray(data.images)) {
      images.push(...data.images.map((x) => x.imageUrl));
    }
  }

  await Promise.allSettled([searchWeb(), searchImages()]);
  return { textBits, links, images };
}

/**
 *
 * @param {string} query Search query
 * @param {SearchRequestOptions} options Search request options
 * @typedef {{useCache?: boolean}} SearchRequestOptions
 * @returns {Promise<{text:string, links: string[], images: string[]}>} Extracted text
 */
async function performSearchRequest(query, options = { useCache: true }) {
  // Check if the query is cached
  const cacheKey = `query_${query}`;
  const cacheLifetime = extension_settings.websearch.cacheLifetime;
  const cachedResult = await storage.getItem(cacheKey);

  if (options.useCache && cachedResult) {
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

  let searchResult;
  try {
    searchResult = await doSerperQuery(query);
  } catch (error) {
    console.error("WebSearch: search failed", error);
    searchResult = { textBits: [], links: [], images: [] };
  }

  const { textBits, links, images } = searchResult;
  const budget = extension_settings.websearch.budget;
  let text = "";

  for (let i of textBits.filter(onlyUnique)) {
    if (i) {
      // Incomplete sentences confuse the model, so we trim them
      if (i.endsWith("...")) {
        i = i.slice(0, -3);
        i = trimToEndSentence(i).trim();
      }

      if (i.startsWith("...")) {
        i = i.slice(3);
        i = trimToStartSentence(i).trim();
      }

      text += i + "\n";
    }
    if (text.length > budget) {
      break;
    }
  }

  // Remove duplicates
  links.splice(0, links.length, ...links.filter(onlyUnique));
  images.splice(0, images.length, ...images.filter(onlyUnique));

  if (!text) {
    console.debug("WebSearch: search produced no text");
    return { text: "", links: [], images: [] };
  }

  console.log(
    `WebSearch: extracted text (length = ${text.length}, budget = ${budget})`,
    text,
  );

  // Save the result to cache
  if (options.useCache) {
    await storage.setItem(cacheKey, {
      text: text,
      links: links,
      images: images,
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
   * @returns {Promise<boolean>} Whether the scraper is available
   */
  async isAvailable() {
    return await isSearchAvailable();
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
      let output = "multiple";
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

      const toast = toastr.info("Working, please wait...");
      const searchResult = await performSearchRequest(query, {
        useCache: false,
      });

      if (
        !Array.isArray(searchResult?.links) ||
        searchResult.links.length === 0
      ) {
        console.debug("WebSearch: no links to scrape");
        return [];
      }

      const visitResults = [];

      for (let i = 0; i < searchResult.links.length; i++) {
        if (i >= maxResults) {
          break;
        }

        const link = searchResult.links[i];

        if (!isAllowedUrl(link)) {
          continue;
        }

        const visitResult = await visitLink(link);

        if (visitResult) {
          visitResults.push(visitResult);
        }
      }

      const files = [];

      if (snippets) {
        const fileName = `snippets - ${query} - ${Date.now()}.txt`;
        const file = new File([searchResult.text], fileName, {
          type: "text/plain",
        });
        files.push(file);
      }

      if (output === "single") {
        let result = "";

        for (const visitResult of visitResults) {
          if (visitResult.text) {
            result += ensureEndNewline(
              substituteParamsExtended(
                extension_settings.websearch.visit_block_header,
                {
                  query: query,
                  link: visitResult.link,
                  text: visitResult.text,
                },
              ),
            );
          }
        }

        const fileHeader = ensureEndNewline(
          substituteParamsExtended(
            extension_settings.websearch.visit_file_header,
            { query: query },
          ),
        );
        const fileText = fileHeader + result;
        const fileName = `websearch - ${query} - ${Date.now()}.txt`;
        const file = new File([fileText], fileName, { type: "text/plain" });
        files.push(file);
      }

      if (output === "multiple") {
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

    if (
      !extension_settings.websearch.use_function_tool ||
      !extension_settings.websearch.enabled
    ) {
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
        if (!(await isSearchAvailable()))
          throw new Error("Search is not available");
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
        if (!(await isSearchAvailable()))
          throw new Error("Search is not available");
        const visitResults = [];

        for (const link of args.links) {
          if (!isAllowedUrl(link)) {
            continue;
          }

          const visitResult = await visitLink(link);

          if (visitResult) {
            visitResults.push(visitResult);
          }
        }

        return visitResults;
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

  // Force source to serper and function tool on
  extension_settings.websearch.source = "serper";
  extension_settings.websearch.use_function_tool = true;

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
  $("#websearch_enabled").prop("checked", extension_settings.websearch.enabled);
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
  $("#websearch_visit_enabled").prop(
    "checked",
    extension_settings.websearch.visit_enabled,
  );
  $("#websearch_visit_enabled").on("change", () => {
    extension_settings.websearch.visit_enabled = !!$(
      "#websearch_visit_enabled",
    ).prop("checked");
    saveSettingsDebounced();
  });
  $(
    `input[name="websearch_visit_target"][value="${extension_settings.websearch.visit_target}"]`,
  ).prop("checked", true);
  $('input[name="websearch_visit_target"]').on("input", () => {
    extension_settings.websearch.visit_target = Number(
      $('input[name="websearch_visit_target"]:checked').val(),
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
          output += "\n" + visitResult;
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
