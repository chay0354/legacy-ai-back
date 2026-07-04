/** Stage 2 — Enriched Avatar: stories, relationships, wisdom (anchor questions from each engine) */
export const ENRICHED_QUESTIONS = [
  {
    module: 'Story Deep-Dive',
    category: 'story_scene',
    q: 'Tell me a story from your life that still matters to you — take me there. What do you remember seeing?',
  },
  {
    module: 'Story Meaning',
    category: 'story_meaning',
    q: 'When you look back on that story now, what does it mean to you? Why do you still remember it?',
  },
  {
    module: 'Story Legacy',
    category: 'story_legacy',
    q: 'What lesson came from that experience? What should future generations learn from this story?',
  },
  {
    module: 'Relationship',
    category: 'relationship_intro',
    q: 'Tell me about someone who shaped who you became. How would you describe them?',
  },
  {
    module: 'Relationship Significance',
    category: 'relationship_significance',
    q: 'Why are they important to you? What part of who you are came from them?',
  },
  {
    module: 'Defining Story',
    category: 'relationship_story',
    q: 'What story best captures who they were — the memory that comes to mind first?',
  },
  {
    module: 'Parent Lessons',
    category: 'relationship_parents',
    q: 'What did your mother or father teach you that stayed with you your whole life?',
  },
  {
    module: 'Wisdom — Marriage',
    category: 'wisdom_marriage',
    q: 'What makes a relationship last? What did love and marriage teach you?',
  },
  {
    module: 'Wisdom — Resilience',
    category: 'wisdom_resilience',
    q: 'How did you survive your hardest times? What kept you going?',
  },
  {
    module: 'Future Generations',
    category: 'wisdom_future',
    q: 'What lesson took you decades to learn — something you hope your grandchildren understand early?',
  },
];

export const ENRICHED_COVERAGE_CATEGORIES = ENRICHED_QUESTIONS.map((q) => q.category);
