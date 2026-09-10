/** Stage 2 — Enriched Avatar: stories, relationships, wisdom (anchor questions from each engine) */
export const ENRICHED_QUESTIONS = [
  {
    module: 'Story Deep-Dive',
    category: 'story_scene',
    q: 'Tell me a story from your life that still matters to you — take me there, in whatever way you remember it.',
    digFor: 'the story as they tell it; place, people, or what they saw/heard if those details arrive',
  },
  {
    module: 'Story Meaning',
    category: 'story_meaning',
    q: 'When you look back on that story now, what does it mean to you? Why do you still remember it?',
    digFor: 'why it stayed with them, in their words — even if they don’t have a neat lesson',
  },
  {
    module: 'Story Legacy',
    category: 'story_legacy',
    q: 'Did anything stay with you from that experience — a lesson, or simply something you never forgot?',
    digFor: 'what they want others to take from it, if anything; stay with their framing',
  },
  {
    module: 'Relationship',
    category: 'relationship_intro',
    q: 'Tell me about someone who shaped who you became. How would you describe them?',
    digFor: 'who they were to them; traits or habits if they paint the person, not a résumé',
  },
  {
    module: 'Relationship Significance',
    category: 'relationship_significance',
    q: 'Why are they important to you? What part of who you are came from them — if that’s how you’d put it?',
    digFor: 'the mark they left, in the speaker’s words; an example if one comes',
  },
  {
    module: 'Defining Story',
    category: 'relationship_story',
    q: 'Is there a memory that captures who they were — the one that comes to mind first?',
    digFor: 'that memory as they hold it; what the person did or said, if they go there',
  },
  {
    module: 'Parent Lessons',
    category: 'relationship_parents',
    q: 'Is there something your mother or father taught you that stayed with you — or a way they were that you still carry?',
    digFor: 'which parent if they say, and the teaching or quality in their words',
  },
  {
    module: 'Wisdom — Marriage',
    category: 'wisdom_marriage',
    q: 'What did love — or a long relationship — teach you? You can talk about what lasted, or what you learned the hard way.',
    digFor: 'what they actually learned; a small real example if they offer one',
  },
  {
    module: 'Wisdom — Resilience',
    category: 'wisdom_resilience',
    q: 'How did you get through your hardest times? What kept you going, if anything did?',
    digFor: 'the hard stretch as they choose to name it, and what helped — or what simply happened',
  },
  {
    module: 'Future Generations',
    category: 'wisdom_future',
    q: 'Is there something that took you years to understand — something you hope the younger ones don’t have to wait as long for?',
    digFor: 'the late-learned thing in their voice; the experience behind it if they share it',
  },
];

export const ENRICHED_COVERAGE_CATEGORIES = ENRICHED_QUESTIONS.map((q) => q.category);
