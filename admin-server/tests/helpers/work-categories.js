const LEGACY_CATEGORY_INPUTS = Object.freeze([
  Object.freeze({
    name: '程序', slug: 'program', kicker: 'PROGRAM / SOFTWARE',
    intro: '软件、网页与系统项目，从可用原型到持续维护的产品记录。',
    emptyText: '程序作品正在整理中，新的项目会从这里出现。',
    displayOrder: 10, isVisible: 1,
  }),
  Object.freeze({
    name: '影视', slug: 'film', kicker: 'FILM / MEDIA',
    intro: '影像、声音与三维创作，记录每一次表达和实验。',
    emptyText: '影视作品正在整理中，新的内容会从这里出现。',
    displayOrder: 20, isVisible: 1,
  }),
  Object.freeze({
    name: '生活', slug: 'life', kicker: 'LIFE / DAILY',
    intro: '来自日常生活的制作、观察和小型实践。',
    emptyText: '生活类作品还在路上，欢迎稍后再来看看。',
    displayOrder: 30, isVisible: 1,
  }),
]);

function seedLegacyCategories(contentService) {
  const existing = new Set(contentService.listCategories().map((category) => category.name));
  for (const input of LEGACY_CATEGORY_INPUTS) {
    if (!existing.has(input.name)) contentService.createCategory(input);
  }
  return contentService.listCategories();
}

module.exports = { LEGACY_CATEGORY_INPUTS, seedLegacyCategories };
