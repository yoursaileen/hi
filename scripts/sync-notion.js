import notionPkg from '@notionhq/client';
const { Client } = notionPkg;
import n2mPkg from 'notion-to-md';
const { NotionToMarkdown } = n2mPkg;

import fs from 'fs';
import path from 'path';
import https from 'https';
import 'dotenv/config';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const POSTS_DIR = path.join(process.cwd(), 'src/content/blog');
const IMAGES_DIR = path.join(process.cwd(), 'public/images/notion');

fs.mkdirSync(POSTS_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download image: ${res.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(filepath);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve();
      });
    }).on('error', reject);
  });
}

async function sync() {
  console.log('Fetching published posts from Notion...');

  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  const dataSourceId = db.data_sources[0].id;

  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      property: 'Status',
      select: { equals: 'Published' },
    },
  });

  for (const file of fs.readdirSync(POSTS_DIR)) {
    if (file.endsWith('.md')) {
      fs.unlinkSync(path.join(POSTS_DIR, file));
    }
  }

  for (const page of response.results) {
    const props = page.properties;
    const title = props.Name?.title?.[0]?.plain_text || 'Untitled';
    const slug = props.Slug?.rich_text?.[0]?.plain_text || page.id;
    const date = props.Date?.date?.start || new Date().toISOString().split('T')[0];
    const description = props.Description?.rich_text?.[0]?.plain_text || '';

    const mdblocks = await n2m.pageToMarkdown(page.id);
    let mdString = n2m.toMarkdownString(mdblocks).parent;

    const imgRegex = /!\[(.*?)\]\((https:\/\/prod-files-secure\.s3\.[^)]+)\)/g;
    let match;
    let imgIndex = 0;

    while ((match = imgRegex.exec(mdString)) !== null) {
      const [fullMatch, altText, imgUrl] = match;
      const ext = path.extname(new URL(imgUrl).pathname) || '.png';
      const localFilename = `${slug}-${imgIndex++}${ext}`;
      const localFilepath = path.join(IMAGES_DIR, localFilename);

      await downloadImage(imgUrl, localFilepath);
      mdString = mdString.replace(fullMatch, `![${altText}](/hi/images/notion/${localFilename})`);
    }

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
      `pubDate: "${date}"`,
      '---',
      '',
    ].join('\n');

    const filename = `${slug}.md`;
    fs.writeFileSync(path.join(POSTS_DIR, filename), frontmatter + mdString);
    console.log(`Synced: ${title}`);
  }
}

sync().catch(console.error);
