import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const INDEX_FILE = path.join(ROOT_DIR, 'index.html');
const OUTPUT_DIR = path.join(ROOT_DIR, 'portfolio', 'behance');
const DATA_FILE = path.join(OUTPUT_DIR, 'projects.json');
const START_MARKER = '<!-- BEHANCE-PROJECTS:START -->';
const END_MARKER = '<!-- BEHANCE-PROJECTS:END -->';
const ENDPOINT = 'https://www.behance.net/v3/graphql';
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

    if (!response.ok) {
      throw new Error(`O Behance respondeu com HTTP ${response.status}.`);
    }

    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(`Erro retornado pelo Behance: ${payload.errors[0].message}`);
    }

    const profileProjects = payload.data?.user?.profileProjects;
    if (!profileProjects) {
      throw new Error(`Perfil "${username}" não encontrado ou sem projetos públicos.`);
    }

    const nodes = profileProjects.nodes ?? [];
    projects.push(...nodes);

    if (!nodes.length || !profileProjects.pageInfo?.hasNextPage) break;
    after = profileProjects.pageInfo.endCursor;
    if (!after) break;
  }

  return projects.slice(0, limit);
}

function getCoverUrl(project) {
  return project.covers?.size_808?.url
    ?? project.covers?.size_original?.url
    ?? project.covers?.size_404?.url
    ?? '';
}

function extensionFrom(response, url) {
  const pathname = new URL(url).pathname;
  const urlExtension = path.extname(pathname).slice(1).toLowerCase();
  const supported = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
  if (supported.has(urlExtension)) return urlExtension === 'jpeg' ? 'jpg' : urlExtension;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

function safeSlug(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'projeto';
}

async function readPreviousProjects() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8')).projects ?? [];
  } catch {
    return [];
  }
}

async function downloadCover(project, previousProject) {
  const coverUrl = getCoverUrl(project);
  if (!coverUrl) return null;

  if (
    previousProject?.coverUrl === coverUrl
    && previousProject?.modifiedOn === project.modifiedOn
    && previousProject?.image
    && existsSync(path.join(ROOT_DIR, previousProject.image))
  ) {
    return previousProject.image;
  }

  const response = await fetch(coverUrl);
  if (!response.ok) throw new Error(`Não foi possível baixar a capa de "${project.name}".`);

  const extension = extensionFrom(response, coverUrl);
  const filename = `${project.id}-${safeSlug(project.slug || project.name)}.${extension}`;
  const relativePath = path.posix.join('portfolio', 'behance', filename);
  const destination = path.join(OUTPUT_DIR, filename);
  const temporary = `${destination}.tmp`;

  await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return relativePath;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
}

function renderProject(project) {
  const labels = (project.fields ?? []).map((field) => field.label).filter(Boolean);
  const tag = labels.slice(0, 2).join(' • ') || 'Projeto Behance';
  const views = formatNumber(project.stats?.views?.all);
  const likes = formatNumber(project.stats?.appreciations?.all);

  return `                        <article class="panel project-card">
                            <a href="${escapeHtml(project.url)}" target="_blank" rel="noreferrer" aria-label="Ver ${escapeHtml(project.name)} no Behance">
                                <img src="${escapeHtml(project.image)}" alt="${escapeHtml(project.name)}" loading="lazy">
                            </a>
                            <div>
                                <span class="tag">${escapeHtml(tag)}</span>
                                <h3><a href="${escapeHtml(project.url)}" target="_blank" rel="noreferrer">${escapeHtml(project.name)}</a></h3>
                                <p>${views} visualizações • ${likes} apreciações</p>
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

  const generated = projects.map(renderProject).join('\n');
  const replacement = `${START_MARKER}\n${generated}\n                        ${END_MARKER}`;
  const updated = html.slice(0, start) + replacement + html.slice(end + END_MARKER.length);
  await writeFile(INDEX_FILE, updated, 'utf8');
}

async function removeStaleImages(previousProjects, currentProjects) {
  const currentImages = new Set(currentProjects.map((project) => project.image).filter(Boolean));

  for (const previous of previousProjects) {
    if (!previous.image || currentImages.has(previous.image)) continue;
    const absolutePath = path.resolve(ROOT_DIR, previous.image);
    if (path.dirname(absolutePath) === OUTPUT_DIR) await rm(absolutePath, { force: true });
  }
}

async function main() {
  const { username, limit } = parseArguments();
  console.log(`Consultando behance.net/${username}...`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const previousProjects = await readPreviousProjects();
  const previousById = new Map(previousProjects.map((project) => [String(project.id), project]));
  const remoteProjects = await fetchProjects(username, limit);

  if (!remoteProjects.length) throw new Error('Nenhum projeto público foi encontrado.');

  const projects = [];
  for (let index = 0; index < remoteProjects.length; index += 1) {
    const project = remoteProjects[index];
    console.log(`[${index + 1}/${remoteProjects.length}] ${project.name}`);
    const image = await downloadCover(project, previousById.get(String(project.id)));
    if (!image) {
      console.warn(`  Aviso: projeto ignorado porque não possui capa.`);
      continue;
    }
    projects.push({ ...project, image, coverUrl: getCoverUrl(project) });
  }

  await updateIndex(projects);
  await writeFile(DATA_FILE, `${JSON.stringify({ username, syncedAt: new Date().toISOString(), projects }, null, 2)}\n`, 'utf8');
  await removeStaleImages(previousProjects, projects);

  console.log(`\nConcluído: ${projects.length} projeto(s) atualizado(s) no site.`);
}

main().catch((error) => {
  console.error(`\nErro: ${error.message}`);
  process.exitCode = 1;
});
