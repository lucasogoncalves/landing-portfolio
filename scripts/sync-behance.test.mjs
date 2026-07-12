import assert from 'node:assert/strict';
import { portfolioProjects, renderPortfolioModule } from './sync-behance.mjs';

const projects = [{
  name: 'Projeto',
  description: 'Descrição',
  image: 'capa.jpg',
  localUrl: 'projetos/projeto/',
  fields: [{ label: 'Branding' }, { label: '' }, { label: 'Web Design' }],
}];

assert.deepEqual(portfolioProjects(projects)[0].tags, ['Branding', 'Web Design']);
assert.match(renderPortfolioModule(projects), /projetos\/projeto\/index\.html/);
assert.match(renderPortfolioModule(projects), /project-tags/);
