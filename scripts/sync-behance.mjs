import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const COVER_DIR = path.join(ROOT_DIR, 'portfolio', 'behance');
const PROJECTS_DIR = path.join(ROOT_DIR, 'projetos');
const DATA_FILE = path.join(COVER_DIR, 'projects.json');
const START_MARKER = '<!-- BEHANCE-PROJECTS:START -->';
const END_MARKER = '<!-- BEHANCE-PROJECTS:END -->';
const ENDPOINT = 'https://www.behance.net/v3/graphql';
const SITE_URL = 'https://lucasogoncalves.github.io/landing-portfolio';
const BASE_PATH = '/landing-portfolio';
const BCP = '96ee8700-3ce5-4445-96b2-ab0e1a76a63a';
const DEFAULT_USERNAME = 'lucas-o-goncalves';
const DEFAULT_LIMIT = 50;

const QUERY = String.raw`
query GetProfileProjects($username: String, $after: String, $first: Int) {
  user(username: $username) {
    profileProjects(first: $first, after: $after) {
      pageInfo { endCursor hasNextPage }
      nodes {
        id
        name
        slug
        url
        publishedOn
        modifiedOn
        fields { id label slug }
        covers {
          size_404 { url }
          size_808 { url }
          size_original { url }
        }
        stats {
          appreciations { all }
          views { all }
          comments { all }
        }
      }
    }
  }
}`;

function parseArguments() {
  const args = process.argv.slice(2);
  let username = DEFAULT_USERNAME;
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--usuario' && args[index + 1]) username = args[++index];
    if (args[index] === '--limite' && args[index + 1]) limit = Number(args[++index]);
  }

  username = username.replace(/^https?:\/\/(?:www\.)?behance\.net\//i, '').replace(/\/$/, '').trim();

  if (!username || !Number.isInteger(limit) || limit < 1) {
    throw new Error('Use: node scripts/sync-behance.mjs --usuario lucas-o-goncalves --limite 50');
  }

  return { username, limit };
}

async function fetchProjects(username, limit) {
  const projects = [];
  let after = null;

  while (projects.length < limit) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-BCP': BCP,
        Cookie: `bcp=${BCP}`,
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          username,
          first: Math.min(50, limit - projects.length),
          after,
        },
      }),
    });

    if (!response.ok) throw new Error(`O Behance respondeu com HTTP ${response.status}.`);

    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`Erro retornado pelo Behance: ${payload.errors[0].message}`);

    const profileProjects = payload.data?.user?.profileProjects;
    if (!profileProjects) throw new Error(`Perfil "${username}" não encontrado ou sem projetos públicos.`);

    const nodes = profileProjects.nodes ?? [];
    projects.push(...nodes);

    if (!nodes.length || !profileProjects.pageInfo?.hasNextPage) break;
    after = profileProjects.pageInfo.endCursor;
    if (!after) break;
  }

  return projects.slice(0, limit);
}

async function fetchProjectHtml(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36',
    },
  });

  if (!response.ok) throw new Error(`Não foi possível ler o projeto (${response.status}): ${url}`);
  return response.text();
}

function getCoverUrl(project) {
  return project.covers?.size_808?.url
    ?? project.covers?.size_original?.url
    ?? project.covers?.size_404?.url
    ?? '';
}

function getAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`(?:^|\\s)${escapedName}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match?.[1] ?? match?.[2] ?? '';
}

function decodeHtml(value) {
  const entities = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };

  return String(value ?? '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return entities[named.toLowerCase()] ?? entity;
  });
}

function selectPresentationUrl(srcset) {
  const candidates = decodeHtml(srcset)
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);

  return candidates.find((url) => url.includes('/1400_webp/')) ?? candidates[0] ?? '';
}

function parseProjectDetails(html) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const descriptionTag = metaTags.find((tag) => getAttribute(tag, 'property') === 'og:description')
    ?? metaTags.find((tag) => getAttribute(tag, 'name') === 'description');
  const description = decodeHtml(getAttribute(descriptionTag ?? '', 'content')).trim();
  const sectionStarts = [...html.matchAll(/<section\b[^>]*class="[^"]*project-module-container[^"]*"[^>]*>/gi)];
  const modules = [];

  for (const sectionStart of sectionStarts) {
    const sectionEnd = html.indexOf('</section>', sectionStart.index);
    if (sectionEnd === -1) continue;
    const section = html.slice(sectionStart.index, sectionEnd + 10);

    if (section.includes('grid--main')) {
      const itemStarts = [...section.matchAll(/<div\b[^>]*class="[^"]*grid__item-container[^"]*"[^>]*>/gi)];
      const images = [];

      for (let index = 0; index < itemStarts.length; index += 1) {
        const itemStart = itemStarts[index];
        const itemEnd = itemStarts[index + 1]?.index ?? section.length;
        const item = section.slice(itemStart.index, itemEnd);
        const sourceTags = item.match(/<source\b[^>]*>/gi) ?? [];
        const sourceTag = sourceTags.find((tag) => getAttribute(tag, 'data-ut') === 'project-module-source-webp')
          ?? sourceTags.find((tag) => getAttribute(tag, 'type') === 'image/webp');
        const sourceUrl = selectPresentationUrl(getAttribute(sourceTag ?? '', 'srcset'));
        if (!sourceUrl || images.some((image) => image.sourceUrl === sourceUrl)) continue;

        const imageTags = item.match(/<img\b[^>]*>/gi) ?? [];
        const visibleImage = imageTags.find((tag) => getAttribute(tag, 'data-ut') === 'project-module-image')
          ?? imageTags.at(-1);

        images.push({
          sourceUrl,
          width: Number(getAttribute(itemStart[0], 'data-width')) || 0,
          height: Number(getAttribute(itemStart[0], 'data-height')) || 0,
          alt: decodeHtml(getAttribute(visibleImage ?? '', 'alt')).trim(),
        });
      }

      if (images.length) modules.push({ type: 'gallery', images });
      continue;
    }

    const imageTags = section.match(/<img\b[^>]*>/gi) ?? [];
    const imageTag = imageTags.find((tag) => {
      const source = getAttribute(tag, 'src');
      return source.includes('project_modules') && !source.includes('/blank.');
    });

    if (!imageTag) continue;
    const sourceUrl = selectPresentationUrl(getAttribute(imageTag, 'srcset')) || decodeHtml(getAttribute(imageTag, 'src'));
    if (!sourceUrl) continue;

    modules.push({
      type: 'full',
      images: [{
        sourceUrl,
        width: Number(getAttribute(imageTag, 'width')) || 0,
        height: Number(getAttribute(imageTag, 'height')) || 0,
        alt: decodeHtml(getAttribute(imageTag, 'alt')).trim(),
      }],
    });
  }

  return { description, modules };
}

function extensionFrom(response, url) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';

  const urlExtension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  const supported = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
  if (supported.has(urlExtension)) return urlExtension === 'jpeg' ? 'jpg' : urlExtension;
  return 'jpg';
}

function safeSlug(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'projeto';
}

function pathExists(relativePath) {
  return Boolean(relativePath) && existsSync(path.resolve(ROOT_DIR, relativePath));
}

async function readPreviousProjects() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8')).projects ?? [];
  } catch {
    return [];
  }
}

async function downloadFile(sourceUrl, outputDirectory, baseName) {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Falha ao baixar uma imagem (${response.status}).`);

  const extension = extensionFrom(response, sourceUrl);
  const filename = `${baseName}.${extension}`;
  const destination = path.join(outputDirectory, filename);
  const temporary = `${destination}.tmp`;

  try {
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return filename;
}

async function downloadCover(project, previousProject) {
  const coverUrl = getCoverUrl(project);
  if (!coverUrl) return null;

  if (
    previousProject?.coverUrl === coverUrl
    && previousProject?.modifiedOn === project.modifiedOn
    && pathExists(previousProject?.image)
  ) {
    return previousProject.image;
  }

  const baseName = `${project.id}-${safeSlug(project.slug || project.name)}`;
  const filename = await downloadFile(coverUrl, COVER_DIR, baseName);
  return path.posix.join('portfolio', 'behance', filename);
}

function allModuleImages(project) {
  return (project.modules ?? []).flatMap((module) => module.images ?? []);
}

function projectDetailsCanBeReused(project, previousProject, localUrl) {
  return previousProject?.modifiedOn === project.modifiedOn
    && previousProject?.localUrl === localUrl
    && typeof previousProject?.description === 'string'
    && Array.isArray(previousProject?.modules)
    && previousProject.modules.length > 0
    && allModuleImages(previousProject).every((image) => pathExists(image.path));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function downloadProjectModules(rawModules, pageSlug, previousProject) {
  const imageDirectory = path.join(PROJECTS_DIR, pageSlug, 'imagens');
  await mkdir(imageDirectory, { recursive: true });

  const previousBySource = new Map(
    allModuleImages(previousProject ?? {}).map((image) => [image.sourceUrl, image]),
  );
  const jobs = [];

  rawModules.forEach((module, moduleIndex) => {
    module.images.forEach((image, imageIndex) => jobs.push({ moduleIndex, imageIndex, image }));
  });

  const downloaded = await mapWithConcurrency(jobs, 5, async ({ moduleIndex, imageIndex, image }) => {
    const previousImage = previousBySource.get(image.sourceUrl);
    if (previousImage && pathExists(previousImage.path)) return { ...image, path: previousImage.path };

    const sourceStem = safeSlug(path.basename(new URL(image.sourceUrl).pathname, path.extname(new URL(image.sourceUrl).pathname))).slice(0, 28);
    const baseName = `${String(moduleIndex + 1).padStart(2, '0')}-${String(imageIndex + 1).padStart(2, '0')}-${sourceStem}`;
    const filename = await downloadFile(image.sourceUrl, imageDirectory, baseName);
    return { ...image, path: path.posix.join('projetos', pageSlug, 'imagens', filename) };
  });

  let cursor = 0;
  return rawModules.map((module) => ({
    type: module.type,
    images: module.images.map(() => downloaded[cursor++]),
  }));
}

function fallbackDescription(project) {
  const labels = (project.fields ?? []).map((field) => field.label).filter(Boolean);
  return labels.length ? `Projeto de ${labels.slice(0, 3).join(', ')}.` : 'Projeto criativo desenvolvido por Lucas O Goncalves.';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function imageSourceForProjectPage(project, image) {
  if (image.path.startsWith(project.localUrl)) return image.path.slice(project.localUrl.length);
  return `../../${image.path}`;
}

function renderDetailModule(project, module, moduleIndex, imageOffset) {
  const images = module.images.map((image, imageIndex) => {
    const source = imageSourceForProjectPage(project, image);
    const alt = image.alt || `${project.name} — imagem ${imageOffset + imageIndex + 1}`;
    const dimensions = image.width && image.height
      ? ` width="${image.width}" height="${image.height}"`
      : '';
    return `                    <img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${dimensions} loading="lazy">`;
  });

  if (module.type === 'gallery') {
    const columns = Math.min(module.images.length, 3);
    return `                <section class="project-detail-gallery" style="--gallery-columns: ${columns}" aria-label="Galeria ${moduleIndex + 1}">
${images.join('\n')}
                </section>`;
  }

  return `                <figure class="project-detail-image">
${images[0]}
                </figure>`;
}

function renderProjectPage(project) {
  let imageOffset = 0;
  const modules = project.modules.map((module, moduleIndex) => {
    const html = renderDetailModule(project, module, moduleIndex, imageOffset);
    imageOffset += module.images.length;
    return html;
  }).join('\n');
  const canonical = `${SITE_URL}/${project.localUrl}`;
  const socialImage = `${SITE_URL}/${project.image}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(project.name)} — Lucas O Goncalves</title>
    <meta name="description" content="${escapeHtml(project.description)}">
    <meta name="author" content="Lucas O Goncalves">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(project.name)}">
    <meta property="og:description" content="${escapeHtml(project.description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:image" content="${escapeHtml(socialImage)}">
    <link rel="icon" type="image/png" href="../../images/favicon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Manrope:wght@400;500;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${BASE_PATH}/style.css">
    <link rel="stylesheet" href="../../style.css">
</head>
<body class="project-detail-body">
    <div class="project-detail-shell">
        <header class="project-detail-header">
            <a class="project-detail-back" href="../../index.html#portfolio">← Voltar ao portfólio</a>
            <span>Projeto</span>
            <h1>${escapeHtml(project.name)}</h1>
            <p>${escapeHtml(project.description)}</p>
        </header>
        <main class="project-detail-modules">
${modules}
        </main>
        <footer class="project-detail-footer">
            <a class="button button-secondary" href="../../index.html#portfolio">Voltar aos projetos</a>
        </footer>
    </div>
</body>
</html>
`;
}

async function writeProjectPage(project) {
  const pageDirectory = path.resolve(ROOT_DIR, project.localUrl);
  await mkdir(pageDirectory, { recursive: true });
  await writeFile(path.join(pageDirectory, 'index.html'), renderProjectPage(project), 'utf8');
}

async function removeObsoleteProjectImages(previousProject, currentProject) {
  const currentPaths = new Set(allModuleImages(currentProject).map((image) => image.path));

  for (const image of allModuleImages(previousProject ?? {})) {
    if (!image.path || currentPaths.has(image.path)) continue;
    const absolutePath = path.resolve(ROOT_DIR, image.path);
    const expectedDirectory = path.join(PROJECTS_DIR, safeSlug(currentProject.slug || currentProject.name), 'imagens');
    if (path.dirname(absolutePath) === expectedDirectory) await rm(absolutePath, { force: true });
  }
}

async function syncProject(project, previousProject, index, total) {
  const pageSlug = safeSlug(project.slug || project.name);
  const localUrl = `${path.posix.join('projetos', pageSlug)}/`;
  const image = await downloadCover(project, previousProject);
  if (!image) throw new Error(`O projeto "${project.name}" não possui capa.`);

  let description;
  let modules;
  let reused = false;

  if (projectDetailsCanBeReused(project, previousProject, localUrl)) {
    description = previousProject.description;
    modules = previousProject.modules;
    reused = true;
  } else {
    const html = await fetchProjectHtml(project.url);
    const details = parseProjectDetails(html);
    description = details.description || fallbackDescription(project);
    modules = await downloadProjectModules(details.modules, pageSlug, previousProject);

    if (!modules.length) {
      modules = [{
        type: 'full',
        images: [{ sourceUrl: getCoverUrl(project), path: image, width: 808, height: 632, alt: project.name }],
      }];
    }
  }

  const syncedProject = {
    ...project,
    image,
    coverUrl: getCoverUrl(project),
    description,
    localUrl,
    modules,
  };

  await writeProjectPage(syncedProject);
  await removeObsoleteProjectImages(previousProject, syncedProject);
  console.log(`[${index + 1}/${total}] ${project.name} — ${reused ? 'sem alterações' : `${allModuleImages(syncedProject).length} imagens`}`);
  return syncedProject;
}

function renderProjectCard(project) {
  const projectPage = `${project.localUrl}index.html`;
  return `                        <article class="panel project-card">
                            <a href="${escapeHtml(projectPage)}" aria-label="Abrir o projeto ${escapeHtml(project.name)}">
                                <img src="${escapeHtml(project.image)}" alt="${escapeHtml(project.name)}" loading="lazy">
                            </a>
                            <div>
                                <h3><a href="${escapeHtml(projectPage)}">${escapeHtml(project.name)}</a></h3>
                                <p>${escapeHtml(project.description)}</p>
                            </div>
                        </article>`;
}

async function updateIndex(projects) {
  const html = await readFile(INDEX_FILE, 'utf8');
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Os marcadores da seção Behance não foram encontrados no index.html.');
  }

  const generated = projects.map(renderProjectCard).join('\n');
  const replacement = `${START_MARKER}\n${generated}\n                        ${END_MARKER}`;
  const updated = html.slice(0, start) + replacement + html.slice(end + END_MARKER.length);
  await writeFile(INDEX_FILE, updated, 'utf8');
}

async function removeStaleCovers(previousProjects, currentProjects) {
  const currentImages = new Set(currentProjects.map((project) => project.image).filter(Boolean));

  for (const previous of previousProjects) {
    if (!previous.image || currentImages.has(previous.image)) continue;
    const absolutePath = path.resolve(ROOT_DIR, previous.image);
    if (path.dirname(absolutePath) === COVER_DIR) await rm(absolutePath, { force: true });
  }
}

async function removeStaleProjectDirectories(previousProjects, currentProjects) {
  const currentUrls = new Set(currentProjects.map((project) => project.localUrl));

  for (const previous of previousProjects) {
    if (!previous.localUrl || currentUrls.has(previous.localUrl)) continue;
    const directory = path.resolve(ROOT_DIR, previous.localUrl);
    const relative = path.relative(PROJECTS_DIR, directory);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function main() {
  const { username, limit } = parseArguments();
  console.log(`Consultando behance.net/${username}...`);

  await mkdir(COVER_DIR, { recursive: true });
  await mkdir(PROJECTS_DIR, { recursive: true });
  const previousProjects = await readPreviousProjects();
  const previousById = new Map(previousProjects.map((project) => [String(project.id), project]));
  const remoteProjects = await fetchProjects(username, limit);

  if (!remoteProjects.length) throw new Error('Nenhum projeto público foi encontrado.');

  const projects = [];
  for (let index = 0; index < remoteProjects.length; index += 1) {
    const project = remoteProjects[index];
    projects.push(await syncProject(project, previousById.get(String(project.id)), index, remoteProjects.length));
  }

  await updateIndex(projects);
  await writeFile(DATA_FILE, `${JSON.stringify({ username, syncedAt: new Date().toISOString(), projects }, null, 2)}\n`, 'utf8');
  await removeStaleCovers(previousProjects, projects);
  await removeStaleProjectDirectories(previousProjects, projects);

  const totalImages = projects.reduce((total, project) => total + allModuleImages(project).length, 0);
  console.log(`\nConcluído: ${projects.length} projetos e ${totalImages} imagens internas disponíveis localmente.`);
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  process.exitCode = 1;
});
