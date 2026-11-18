import notionPkg from "@notionhq/client";
const { Client } = notionPkg;
import n2mPkg from "notion-to-md";
const { NotionToMarkdown } = n2mPkg;

import fs from "fs";
import path from "path";
import https from "https";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const POSTS_DIR = path.join(process.cwd(), "src/content/blog");
const IMAGES_DIR = path.join(process.cwd(), "public/images/notion");

// Check if --drafts flag was passed
const INCLUDE_DRAFTS = process.argv.includes("--drafts");

fs.mkdirSync(POSTS_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download image: ${res.statusCode}`));
          return;
        }
        const stream = fs.createWriteStream(filepath);
        res.pipe(stream);
        stream.on("finish", () => {
          stream.close();
          resolve();
        });
      })
      .on("error", reject);
  });
}

function slugify(text) {
  return (text || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

async function sync() {
  console.log(
    INCLUDE_DRAFTS
      ? "Fetching published and draft posts from Notion..."
      : "Fetching published posts from Notion..."
  );

  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  const dataSourceId = db.data_sources[0].id;

  const filter = INCLUDE_DRAFTS
    ? {
        or: [
          { property: "Status", select: { equals: "Published" } },
          { property: "Status", select: { equals: "Draft" } },
          { property: "Status", select: { is_empty: true } },
        ],
      }
    : {
        property: "Status",
        select: { equals: "Published" },
      };

  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter,
  });

  // Clean up existing posts and draft images before syncing
  for (const file of fs.readdirSync(POSTS_DIR)) {
    if (file.endsWith(".md")) {
      fs.unlinkSync(path.join(POSTS_DIR, file));
    }
  }
  for (const file of fs.readdirSync(IMAGES_DIR)) {
    if (file.startsWith("_draft-")) {
      fs.unlinkSync(path.join(IMAGES_DIR, file));
    }
  }

  const usedSlugs = new Set();

  for (const page of response.results) {
    const props = page.properties;

    const status = props.Status?.select?.name || "Draft";
    const isDraft = status !== "Published";
    const prefix = isDraft ? "_draft-" : "";

    const lastEditedDate = page.last_edited_time.split("T")[0];
    const date = props.Date?.date?.start || lastEditedDate;

    const rawTitle = props.Name?.title
      ?.map((t) => t.plain_text)
      .join("")
      .trim();
    const title = rawTitle || date;

    const description = (
      props.Description?.rich_text?.map((t) => t.plain_text).join("") || ""
    )
      .replace(/\r?\n/g, " ")
      .trim();

    const cleanId = page.id.replace(/-/g, "");
    const baseSlug = slugify(rawTitle) || cleanId;
    let slug = baseSlug;

    if (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${cleanId}`;
    }
    usedSlugs.add(slug);

    const mdblocks = await n2m.pageToMarkdown(page.id);
    let mdString = n2m.toMarkdownString(mdblocks).parent || "";

    const imgRegex =
      /!\[(.*?)\]\((https:\/\/(?:prod-files-secure\.s3\.|s3\.us-west-2\.amazonaws\.com)[^)]+)\)/g;
    const matches = [...mdString.matchAll(imgRegex)];
    let imgIndex = 0;

    for (const match of matches) {
      const [fullMatch, altText, imgUrl] = match;
      const ext = path.extname(new URL(imgUrl).pathname) || ".png";
      const localFilename = `${prefix}${slug}-${imgIndex++}${ext}`;
      const localFilepath = path.join(IMAGES_DIR, localFilename);

      await downloadImage(imgUrl, localFilepath);

      const localUrl = `/hi/images/notion/${localFilename}`;
      const cleanCaption = altText.trim();

      if (cleanCaption) {
        const safeCaption = cleanCaption
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");

        mdString = mdString.replace(
          fullMatch,
          `<figure>\n  <img src="${localUrl}" alt="${safeCaption}" />\n  <figcaption>${safeCaption}</figcaption>\n</figure>`
        );
      } else {
        mdString = mdString.replace(fullMatch, `!(${localUrl})`);
      }
    }

    const frontmatter = [
      "---",
      `title: "${title.replace(/"/g, '\\"')}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
      `pubDate: "${date}"`,
      `draft: ${isDraft}`,
      "---",
      "",
    ].join("\n");

    const filename = `${prefix}${slug}.md`;
    fs.writeFileSync(path.join(POSTS_DIR, filename), frontmatter + mdString);
    console.log(`Synced (${status}): ${title} -> ${filename}`);
  }
}

sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
