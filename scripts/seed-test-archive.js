/**
 * Fill a test archive with realistic content so every band of the archive
 * screens has something to show.
 *
 * Usage: node scripts/seed-test-archive.js [email]
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env
 *
 * Re-runnable: every row written here carries metadata.seed = 'test-archive'
 * and is removed before the next run, so hand-entered content is left alone.
 * Coverage scores, stage progress and the personality profile are merged, not
 * replaced.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { FOUNDATION_QUESTIONS } from '../src/foundationQuestions.js';
import { ENRICHED_QUESTIONS } from '../src/enrichedQuestions.js';
import { LEGACY_QUESTIONS } from '../src/legacyQuestions.js';

const SEED = 'test-archive';
const BUCKET = 'legacy-media';
const email = (process.argv[2] || 'chay.moalem2108@gmail.com').trim().toLowerCase();

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const MEMORIES = [
  {
    title: 'Friday nights at the kitchen table',
    year: '1994',
    age: '7',
    category: 'childhood',
    location: 'Haifa',
    summary:
      'Every Friday the table was pulled away from the wall so eight people could sit at it. My mother cooked from Wednesday. Nobody was allowed to leave before the arguing about politics was finished.',
    full_transcript:
      'The table was too small for us, so on Fridays my father pulled it away from the wall and we brought in the two folding chairs from the balcony. My mother started cooking on Wednesday. There was always more food than we could eat and she always said there was not enough. My grandfather sat at the end and argued about politics with my uncle until my mother told them both to be quiet, and then they argued more quietly. I was seven and I understood none of it, but I understood that leaving the table early was not allowed. That is where I learned that people who love each other can shout and still pass the bread.',
    people_involved: ['Rivka', 'Dov', 'Zeev'],
    tags: ['shabbat', 'family', 'haifa'],
    emotional_significance: 'The measure of a home for me is still whether people stay at the table.',
    lesson_learned: 'Nobody leaves the table angry. You can argue and still pass the bread.',
    importance: 'high',
  },
  {
    title: 'The hill behind the house',
    year: '1996',
    age: '9',
    category: 'childhood',
    location: 'Haifa',
    summary:
      'My father took the training wheels off without telling me and pointed me down the hill. I fell twice and then I did not fall.',
    full_transcript:
      'He took the training wheels off on a Thursday and did not tell me. He walked me to the top of the hill behind the house and said, the bicycle knows how, you only have to stop arguing with it. I fell twice. The second time I tore my knee and I wanted to go home. He did not pick me up and he did not tell me it was fine. He just stood there at the bottom of the hill and waited. The third time I got to the bottom and he was still standing exactly where he had been.',
    people_involved: ['Dov'],
    tags: ['father', 'bicycle', 'stubbornness'],
    emotional_significance: 'The first time I understood that being helped is not the same as being carried.',
    lesson_learned: 'Stand at the bottom of the hill. Do not carry the bicycle.',
    importance: 'medium',
  },
  {
    title: "The summer in Zeev's garage",
    year: '2001',
    age: '14',
    category: 'career',
    location: 'Haifa',
    summary:
      "I spent a summer handing tools to my uncle Zeev. He paid me badly and taught me that a job you did not finish properly comes back with the same car.",
    full_transcript:
      'My uncle Zeev had a garage on a street with three garages on it. The summer I was fourteen he let me sweep and hand him tools, and by August he let me change oil. He paid me almost nothing and he was not kind about mistakes. He had one rule he repeated so often it became a joke in the family: the car comes back. If you close it badly, it comes back, and it comes back with the same person sitting in it looking at you. I have thought about that sentence in every job I have had since, none of which involved cars.',
    people_involved: ['Zeev'],
    tags: ['work', 'uncle', 'craft'],
    emotional_significance: 'The first work I was proud of, and the first work I was ashamed of.',
    lesson_learned: 'Bad work comes back with the same person sitting in it.',
    importance: 'high',
  },
  {
    title: 'The friends who stayed after the army',
    year: '2006',
    age: '19',
    category: 'life_chapters',
    location: 'Negev',
    summary:
      'Three years of service, most of it boring, and four friendships that survived it. Yossi is still the person I call first when something is wrong.',
    full_transcript:
      'People ask about the army as if the story is the dramatic parts. Most of it was waiting, cold nights, bad coffee and jokes that would not be funny anywhere else. What I kept from it was four people. Three of them drifted. Yossi did not. Twenty years later he is still the first person I call when something is wrong, and he still answers in one ring and says nothing for the first ten seconds so that I can talk.',
    people_involved: ['Yossi'],
    tags: ['service', 'friendship'],
    emotional_significance: 'Proof that the friends you keep are chosen, not collected.',
    lesson_learned: 'A friend is someone who is quiet for the first ten seconds.',
    importance: 'medium',
  },
  {
    title: 'The night I met Noa',
    year: '2011',
    age: '24',
    category: 'love_family',
    location: 'Tel Aviv',
    summary:
      'A friend of a friend dragged me to a birthday party I did not want to attend. Noa was on the balcony arguing with someone about a building she thought was ugly. I agreed with her about the building.',
    full_transcript:
      'I did not want to go. It was somebody\u2019s birthday in an apartment I had never been to and I had already put my shoes back on twice. She was on the balcony arguing about a building across the street that she said was an insult to the street. The man she was arguing with gave up and went inside. I said I agreed with her about the building, which was true, and then I stayed on that balcony for four hours. At two in the morning she said, you are still here, and I said, I am still here. That has more or less been the arrangement ever since.',
    people_involved: ['Noa'],
    tags: ['noa', 'tel aviv', 'first meeting'],
    emotional_significance: 'The night the rest of my life started, disguised as a party I wanted to leave.',
    lesson_learned: 'Go to the party you do not want to go to. Once.',
    importance: 'high',
  },
  {
    title: 'The wedding under the fig tree',
    year: '2013',
    age: '26',
    category: 'love_family',
    location: 'Kibbutz Hanaton',
    summary:
      'Sixty people, a borrowed sound system and a fig tree. It rained for eleven minutes in the middle of the ceremony and nobody moved.',
    full_transcript:
      'We wanted small and we got small: sixty people, a borrowed sound system and a fig tree that my aunt had decided years earlier was where this would happen. In the middle of the ceremony it rained for about eleven minutes, which is not supposed to happen in June, and not one person moved. My father cried, which I had never seen. Noa\u2019s mother sang something in Ladino that nobody could translate and everybody understood. We ran out of wine an hour before the end and it did not matter at all.',
    people_involved: ['Noa', 'Rivka', 'Dov'],
    tags: ['wedding', 'rain', 'family'],
    emotional_significance: 'The clearest hour of my life. I remember the smell of wet dust.',
    lesson_learned: 'Do not move because of the rain.',
    importance: 'high',
  },
  {
    title: 'The first company, and how it ended',
    year: '2015',
    age: '28',
    category: 'career',
    location: 'Tel Aviv',
    summary:
      'Two years, four people, one product nobody needed. I paid everyone their last month out of my own account and then sat in the empty office for an afternoon.',
    full_transcript:
      'We built something well that nobody needed, which is the most expensive mistake available. I knew by the end of the first year and I kept going for another one because stopping felt like a verdict about me. When it ended I paid the last month out of my own account, which I do not regret, and then I sat in the empty office for an afternoon with the chairs still in it. What I remember is not the failure. It is the phone call to each of the four of them, one after another, and how none of them were surprised. They had all known before I admitted it.',
    people_involved: ['Yossi', 'Noa'],
    tags: ['failure', 'business', 'honesty'],
    emotional_significance: 'The most useful bad year I have had.',
    lesson_learned: 'The people around you know before you admit it. Ask them earlier.',
    importance: 'high',
  },
  {
    title: 'The morning Maya was born',
    year: '2017',
    age: '30',
    category: 'love_family',
    location: 'Tel Aviv',
    summary:
      'Nineteen hours, then a nurse handed her to me and left the room, which struck me as an enormous administrative error.',
    full_transcript:
      'Nineteen hours. Noa was extraordinary and I was useless in a way I had not prepared for. At six in the morning a nurse put Maya in my arms and then walked out of the room, and my first clear thought was that somebody had made an enormous administrative error, that a person like me should not be handed a person like this without supervision. She weighed almost nothing. I stood by the window until the sun came up over the buildings and I made her exactly one promise, which I am not going to repeat here because it is hers.',
    people_involved: ['Noa', 'Maya'],
    tags: ['maya', 'birth', 'fatherhood'],
    emotional_significance: 'Everything before this is a different life.',
    lesson_learned: 'Nobody is qualified. You do it anyway.',
    importance: 'high',
  },
  {
    title: 'Starting again, smaller',
    year: '2018',
    age: '31',
    category: 'career',
    location: 'Tel Aviv',
    summary:
      'I went back to work for someone else for two years on purpose. It was the least impressive and most useful decision of my career.',
    full_transcript:
      'After the company closed, everyone expected the next thing immediately. I took a salaried job instead and stayed two years. It looked like a step backwards and it was the most useful thing I did in that decade. I learned what I had been bad at by watching somebody competent do it in front of me every day. Pride is expensive. Two years of somebody else paying for my education was cheap.',
    people_involved: ['Noa'],
    tags: ['career', 'humility', 'rebuilding'],
    emotional_significance: 'Proof that going backwards on paper is not going backwards.',
    lesson_learned: 'Take the unimpressive job that teaches you the thing you lack.',
    importance: 'medium',
  },
  {
    title: 'Teaching Maya to swim',
    year: '2022',
    age: '35',
    category: 'family',
    location: 'Ashdod',
    summary:
      'She was afraid of putting her face in the water for a whole summer. I stood in the shallow end for a whole summer.',
    full_transcript:
      'She was five and she was not afraid of the water, only of putting her face in it. Every instructor told me to push her, and I remembered standing at the bottom of a hill with a bicycle. So I stood in the shallow end and did nothing for most of a summer, which is much harder than it sounds. In August she did it without announcing it. She came up furious that I had not been watching, and I had been watching for two months.',
    people_involved: ['Maya'],
    tags: ['maya', 'patience', 'fatherhood'],
    emotional_significance: 'The summer I understood my father.',
    lesson_learned: 'Waiting is a form of teaching. It is also the hardest one.',
    importance: 'high',
  },
  {
    title: 'Itai’s questions arrive late',
    year: '2023',
    age: '36',
    category: 'love_family',
    location: 'Tel Aviv',
    summary:
      'Itai was three. He sat through a whole dinner without speaking and then, while I was washing the plates, asked why people die. He had been thinking about it for days.',
    full_transcript:
      'Maya talks while a thing is happening. Itai talks three days later. One Thursday I was washing plates and he stood next to the sink, which is his way of announcing a conversation, and asked why people die. Not as a performance. He had been sitting with it. I told him the true version I could give a three-year-old and he nodded as if he had already known and only wanted confirmation. Then he asked if the fig tree at the kibbutz would die too, which is how I knew he had been listening at the wedding stories. He is the quiet one and he misses nothing.',
    people_involved: ['Itai', 'Maya', 'Noa'],
    tags: ['itai', 'fatherhood', 'questions'],
    emotional_significance: 'The first time I understood that the quieter child is not the easier one.',
    lesson_learned: 'The question that arrives late is the one that was being carried.',
    importance: 'high',
  },
  {
    title: 'Rivka’s last Friday in the old kitchen',
    year: '2019',
    age: '32',
    category: 'family',
    location: 'Haifa',
    summary:
      'We sold the apartment. The last Friday she cooked anyway, for six people, in a kitchen that already had boxes in it.',
    full_transcript:
      'The apartment went in 2019. My mother cooked the last Friday as if nothing was happening, with boxes stacked against the wall she used to lean on. My father sat in his chair, which was already tagged for the movers, and argued about the news. Nobody mentioned that it was the last one. At the end she packed the leftover soup into a pot that was coming with us and said, eat it tomorrow, it is better on the second day. That is the whole of her. She will feed you on the way out of a house.',
    people_involved: ['Rivka', 'Dov', 'Noa', 'Maya'],
    tags: ['haifa', 'leaving', 'mother'],
    emotional_significance: 'The end of the house I measured every other house against.',
    lesson_learned: 'People tell you they love you by feeding you on the day the house is empty.',
    importance: 'medium',
  },
];

const RELATIONSHIPS = [
  {
    name: 'Noa',
    relationship_type: 'Wife',
    description: 'Met on a balcony in 2011, married under a fig tree in 2013.',
    relationship_summary:
      'The person I think out loud with. She disagrees with me faster than anyone else and she is right often enough that I have stopped resenting it.',
    emotional_tone: 'warm',
    importance_score: 98,
    influence_score: 95,
  },
  {
    name: 'Maya',
    relationship_type: 'Daughter',
    description: 'Born in Tel Aviv in 2017.',
    relationship_summary:
      'Stubborn in exactly the way I was stubborn, which is inconvenient and funny. Everything I am recording is finally addressed to her.',
    emotional_tone: 'tender',
    importance_score: 97,
    influence_score: 90,
  },
  {
    name: 'Itai',
    relationship_type: 'Son',
    description: 'Born in 2020, three years after his sister.',
    relationship_summary:
      'Quieter than his sister and watches everything. Asks the question three days after the conversation ended.',
    emotional_tone: 'tender',
    importance_score: 96,
    influence_score: 84,
  },
  {
    name: 'Rivka',
    relationship_type: 'Mother',
    description: 'Cooked from Wednesday for a Friday table that was always too small.',
    relationship_summary:
      'Where the hospitality comes from, and the worrying. She has never once let anyone leave her house without eating.',
    emotional_tone: 'warm',
    importance_score: 92,
    influence_score: 88,
  },
  {
    name: 'Dov',
    relationship_type: 'Father',
    description: 'Took the training wheels off without warning and waited at the bottom of the hill.',
    relationship_summary:
      'Not a talkative man. Almost everything I believe about work and about waiting came from watching him rather than from being told.',
    emotional_tone: 'respectful',
    importance_score: 94,
    influence_score: 93,
  },
  {
    name: 'Yossi',
    relationship_type: 'Oldest friend',
    description: 'Met during service in 2006 and never lost touch.',
    relationship_summary:
      'Answers in one ring and stays quiet for the first ten seconds so I can talk. Twenty years of that.',
    emotional_tone: 'loyal',
    importance_score: 86,
    influence_score: 74,
  },
  {
    name: 'Zeev',
    relationship_type: 'Uncle',
    description: 'Ran a garage in Haifa and gave me my first job at fourteen.',
    relationship_summary:
      'Taught me that bad work comes back with the same person sitting in it. Hard to please and worth pleasing.',
    emotional_tone: 'admiring',
    importance_score: 78,
    influence_score: 80,
  },
  {
    name: 'Leah',
    relationship_type: 'Grandmother',
    description: 'My mother’s mother. Sang in Ladino and never translated.',
    relationship_summary:
      'Sat at the Friday table until she could not. Left behind a song nobody in the family can name and all of us can hum.',
    emotional_tone: 'tender',
    importance_score: 74,
    influence_score: 60,
  },
];

const VALUES = [
  {
    value_name: 'Finish the work properly',
    description: 'A job closed badly returns with the same person sitting in it.',
    origin_story: "The summer in Zeev's garage, 2001.",
    is_core: true,
    importance_score: 95,
    confidence_score: 90,
    supporting_stories: ["The summer in Zeev's garage"],
  },
  {
    value_name: 'Stay at the table',
    description: 'Disagreement is not a reason to leave. People who love each other can shout and still pass the bread.',
    origin_story: 'Friday nights in Haifa.',
    is_core: true,
    importance_score: 93,
    confidence_score: 88,
    supporting_stories: ['Friday nights at the kitchen table'],
  },
  {
    value_name: 'Wait instead of pushing',
    description: 'Standing at the bottom of the hill is help. Carrying the bicycle is not.',
    origin_story: 'My father on the hill, and a summer in the shallow end with Maya.',
    is_core: true,
    importance_score: 91,
    confidence_score: 86,
    supporting_stories: ['The hill behind the house', 'Teaching Maya to swim'],
  },
  {
    value_name: 'Pay people first',
    description: 'When something ends, the people who worked for you are paid before your pride is.',
    origin_story: 'The last month of the first company, 2015.',
    is_core: false,
    importance_score: 84,
    confidence_score: 82,
    supporting_stories: ['The first company, and how it ended'],
  },
  {
    value_name: 'Take the unimpressive job',
    description: 'Choose the room where somebody is better than you at the thing you are bad at.',
    origin_story: 'Two salaried years after the company closed.',
    is_core: false,
    importance_score: 76,
    confidence_score: 78,
    supporting_stories: ['Starting again, smaller'],
  },
  {
    value_name: 'Feed people',
    description: 'Nobody leaves the house without eating. Inherited, not chosen.',
    origin_story: 'My mother, every Friday of my childhood.',
    is_core: false,
    importance_score: 72,
    confidence_score: 85,
    supporting_stories: ['Friday nights at the kitchen table'],
  },
];

const WISDOM = [
  {
    title: 'On disagreement',
    advice_statement: 'You can argue and still pass the bread. Leaving the table is the only real fight.',
    life_category: 'Family',
    supporting_story: 'Friday nights at the kitchen table',
    supporting_value: 'Stay at the table',
    importance_score: 94,
    confidence_score: 90,
  },
  {
    title: 'On helping',
    advice_statement: 'Stand at the bottom of the hill. Do not carry the bicycle.',
    life_category: 'Parenting',
    supporting_story: 'The hill behind the house',
    supporting_value: 'Wait instead of pushing',
    importance_score: 92,
    confidence_score: 92,
  },
  {
    title: 'On work',
    advice_statement: 'Close it properly. Bad work comes back, and it comes back with the same person sitting in it.',
    life_category: 'Work',
    supporting_story: "The summer in Zeev's garage",
    supporting_value: 'Finish the work properly',
    importance_score: 90,
    confidence_score: 88,
  },
  {
    title: 'On knowing when to stop',
    advice_statement: 'The people around you know before you admit it. Ask them a year earlier than you want to.',
    life_category: 'Work',
    supporting_story: 'The first company, and how it ended',
    supporting_value: 'Finish the work properly',
    importance_score: 88,
    confidence_score: 84,
  },
  {
    title: 'On being unqualified',
    advice_statement: 'Nobody is qualified for the things that matter. You are handed them anyway and you do them.',
    life_category: 'Parenting',
    supporting_story: 'The morning Maya was born',
    supporting_value: 'Wait instead of pushing',
    importance_score: 86,
    confidence_score: 80,
  },
  {
    title: 'On pride',
    advice_statement: 'Pride is the most expensive thing I have ever paid for, and I paid for it twice.',
    life_category: 'Character',
    supporting_story: 'Starting again, smaller',
    supporting_value: 'Take the unimpressive job',
    importance_score: 82,
    confidence_score: 78,
  },
  {
    title: 'On friendship',
    advice_statement: 'A real friend is quiet for the first ten seconds so that you can talk.',
    life_category: 'Friendship',
    supporting_story: 'The friends who stayed after the army',
    supporting_value: 'Stay at the table',
    importance_score: 78,
    confidence_score: 82,
  },
  {
    title: 'On weather',
    advice_statement: 'Do not move because of the rain. Almost nothing that interrupts you is worth standing up for.',
    life_category: 'Character',
    supporting_story: 'The wedding under the fig tree',
    supporting_value: 'Stay at the table',
    importance_score: 74,
    confidence_score: 76,
  },
];

const THREADS = [
  {
    title: 'What my grandfather did before 1948',
    origin_statement: 'He argued politics at every Friday table and never once talked about before.',
    category: 'family',
    priority: 'high',
    related_people: ['Zeev', 'Rivka'],
  },
  {
    title: 'The promise made at the hospital window',
    origin_statement: 'I made Maya exactly one promise that morning and I have not said it out loud since.',
    category: 'love_family',
    priority: 'high',
    related_people: ['Maya'],
  },
  {
    title: 'The four people from the first company',
    origin_statement: 'None of them were surprised when I called. I have never asked them when they knew.',
    category: 'career',
    priority: 'medium',
    related_people: ['Yossi'],
  },
  {
    title: "Noa's mother's song at the wedding",
    origin_statement: 'Nobody could translate it and everybody understood it. I still do not know what it was.',
    category: 'love_family',
    priority: 'medium',
    related_people: ['Noa'],
  },
];

const COVERAGE = {
  identity: 92,
  family: 94,
  childhood: 90,
  life_chapters: 88,
  relationships: 93,
  love_family: 96,
  career: 86,
  values: 91,
  advice: 89,
  personality: 84,
  story_scene: 90,
  story_meaning: 88,
  story_legacy: 86,
  relationship_intro: 92,
  relationship_significance: 90,
  relationship_story: 88,
  relationship_parents: 91,
  wisdom_marriage: 90,
  wisdom_resilience: 87,
  wisdom_future: 85,
  legacy_remembered: 90,
  legacy_preserve: 88,
  legacy_future: 86,
  legacy_family: 92,
  legacy_story: 89,
  legacy_lesson: 91,
  legacy_meaning: 88,
  legacy_misunderstood: 80,
  legacy_summary: 86,
  legacy_letter: 84,
  legacy_final: 82,
  legacy_gratitude: 90,
  legacy_hope: 88,
};

const GALLERY = [
  { title: 'The kitchen table', caption: 'Haifa, around 1994. The table pulled away from the wall for Friday.' },
  { title: 'The hill behind the house', caption: 'The street I learned to ride on, photographed years later.' },
  { title: "Zeev's garage", caption: 'Haifa, 2001. Third from the left, holding a wrench I was not qualified to hold.' },
  { title: 'Under the fig tree', caption: 'Kibbutz Hanaton, June 2013. Eleven minutes before the rain.' },
  { title: 'The first office', caption: 'Tel Aviv, 2014. Four desks and a product nobody needed.' },
  { title: 'Ashdod, August', caption: 'The summer Maya put her face in the water.' },
  { title: 'Itai at the sink', caption: 'Tel Aviv, 2023. The evening the questions started arriving late.' },
];

const PERSONALITY = {
  communication_style: 'Direct and unhurried. Understates rather than overstates, and answers with a story before an opinion.',
  humor_style: 'Dry, self-deprecating, delivered flat. Rarely explains the joke.',
  emotional_style: 'Reserved in the moment, honest afterwards. Says the difficult thing a day late rather than never.',
  storytelling_style: 'Concrete detail first, meaning last, and only if asked. Names the place and the year.',
  decision_making_style: 'Slow to commit, then hard to move. Consults Noa before anything that matters.',
  traits: {
    stubborn: 'high',
    patient: 'high',
    sentimental: 'low in speech, high in practice',
    optimistic: 'moderate',
    private: 'high',
  },
  favorite_phrases: [
    'The car comes back.',
    'Do not carry the bicycle.',
    'We are still here.',
    'Nobody leaves without eating.',
  ],
};

const FOUNDATION_ANSWERS = [
  'I would want them to know I am Chay, from Haifa, a husband to Noa and a father to Maya and Itai. I work with my hands and with people, and I stay at the table after the argument is over. I am not interesting in the abstract. I am a person who waited at the bottom of a hill and later waited in the shallow end of a pool.',
  'I grew up in a small apartment in Haifa with my mother Rivka, my father Dov, and a table that was always too small for Friday. My uncle Zeev came most weeks from the garage. Home smelled like soup from Wednesday and sounded like politics. Nobody was allowed to leave before the arguing was finished.',
  'I am on the balcony. It is summer. My father is oiling a bicycle chain and I am watching the oil go into the links. I am about four. The metal is warm. That is the first picture that still has a smell attached to it.',
  'Haifa, the army, the years of trying to build something in Tel Aviv, marrying Noa, the company that failed, Maya, going back to a salaried job, Itai, and the quieter years of being a father. Those are the chapters. None of them is a clean ending.',
  'Noa. Maya. Itai. My father Dov, who taught me to wait. My mother Rivka, who taught me to feed people. Yossi, who answers in one ring. Zeev, who taught me that bad work comes back.',
  'A friend of a friend dragged me to a birthday I wanted to leave. Noa was on the balcony arguing that a building across the street was an insult to the street. I agreed with her about the building and stayed four hours. At two in the morning she said, you are still here. That has more or less been the arrangement since 2011. We married under a fig tree in 2013 while it rained.',
  'I have built things that worked and one company that did not. I am proudest of paying the four people their last month when it ended, and of the two unimpressive years I spent afterwards learning what I was bad at. The garage summer with Zeev when I was fourteen is still the job I measure the others against.',
  'Finish the work properly. Stay at the table. Wait instead of pushing. Pay people first. Those are not slogans. They each have a year attached.',
  'Stand at the bottom of the hill. Do not carry the bicycle. I learned it from my father when I was nine, and I had to learn it again in a swimming pool with Maya.',
  'Dry jokes delivered flat, usually about myself. I say “the car comes back” when someone wants to rush a job, and “we are still here” when Noa looks at me on a hard day. I do not explain the joke.',
];

const ENRICHED_ANSWERS = [
  'The kitchen in Haifa on a Friday. The table has been pulled away from the wall. There are two folding chairs from the balcony. My grandfather is at the end arguing. My mother is carrying a pot that is too heavy and will not let anyone help her. I can still hear the spoons against the bowls. I was seven and I was not allowed to leave.',
  'It is the measure of a home for me. If people stay at the table after they have disagreed, the house is working. I remember it because I have been in rooms since then where people left, and those rooms did not feel like home.',
  'Nobody leaves the table angry. You can argue and still pass the bread. That is the whole lesson. If future people in this family remember one rule, I would like it to be that one.',
  'My father Dov. Not talkative. Stood at the bottom of a hill with a bicycle and did not pick me up. He taught by remaining in place. His hands always smelled slightly of oil. He cried at my wedding, which I had never seen.',
  'Patience, and the difference between helping and carrying. I thought for years that a good person solves the problem. He showed me that a good person stays nearby while you solve it. I used it with Maya in the pool and I use it with Itai when the questions arrive three days late.',
  'He took the training wheels off on a Thursday and did not tell me. He walked me to the top of the hill behind the house and said the bicycle knows how. I fell twice. He did not move. The third time I got to the bottom and he was still standing exactly where he had been.',
  'My father taught me to wait. My mother taught me that nobody leaves without eating. I use both of those every week. The waiting is harder.',
  'You stay. Not dramatically. You stay on the balcony at two in the morning, and you stay at the table, and you stay in the room after the company has failed. Love is mostly the decision not to leave when leaving would be easier. The rain at the wedding is the picture of it: nobody moved.',
  'When the first company ended I sat in the empty office for an afternoon. What kept me going was the four phone calls, and then Noa, who did not treat it as a verdict about me. Pride wanted me to start the next thing immediately. I took a salaried job instead. That was the survival: becoming unimpressive on purpose.',
  'Pride is expensive. Ask the people around you a year earlier than you want to. The four people at that company knew before I admitted it. I would like Maya and Itai to learn that while they still have time to be wrong cheaply.',
];

const LEGACY_ANSWERS = [
  'That I stayed. That I paid people. That I stood in the shallow end for a summer. That I passed the bread. I would rather they remember a few ordinary scenes than a speech about the kind of man I was.',
  'Friday. The table. Feeding people even when the house is in boxes. The rule that you do not leave angry. If those go, the family becomes a group of relatives, which is not the same thing.',
  'You will be unqualified for the things that matter and you will do them anyway. Nobody hands you a certificate at the hospital window. The work is to stay in the room.',
  'It means you argue and you still eat. It means a song in Ladino that nobody can translate. It means Zeev’s garage and Rivka’s soup and a fig tree that got rained on. Special is the wrong word. Reliable is closer.',
  'The morning Maya was born. A nurse handed her to me and left, which struck me as an administrative error. I stood by the window until the sun came up and I made her one promise I am not going to write here because it is hers. If they can only have one story, that is the one, because everything after it is a different life.',
  'Stand at the bottom of the hill. Do not carry the bicycle. It applies to children, to work, and to pride.',
  'What mattered most was staying. What mattered less than I expected was being impressive. The empty office taught me that faster than any success would have.',
  'People think speed is a virtue. Most of the useful things I have done took a summer of standing still. Waiting looks like doing nothing until the third time down the hill.',
  'I grew up in Haifa at a Friday table that was too small. I learned work in a garage that smelled of oil. I married Noa under a fig tree in the rain. I built a company that nobody needed and I paid everyone on the way out. I became a father twice and I am still unqualified. That is the shape of it. I am still here.',
  'If you are reading this a hundred years from now: eat first. Stay for the argument. Do not confuse helping with carrying. Tell the truth a day late rather than never. The fig tree, if it is still there, is where we stood in the rain and did not move.',
  'I am grateful. I am proud of you in the ordinary way, which is the only way that lasts. I did not say enough of that while I was in the room. Say it for me if you need to. Pass the bread.',
  'Noa, who stayed on a balcony. Maya and Itai, who arrived without asking whether I was ready. My father, who waited. My mother, who fed us on the last Friday in a kitchen full of boxes. Yossi, who answers. The luck of a rain that lasted eleven minutes and did not ruin anything.',
  'That they keep the table. That Maya and Itai remain the kind of people who ask the real question three days later. That nobody in this family has to be impressive to be kept.',
];

function answersFor(questions, texts) {
  return questions.map((q, i) => ({
    question_index: i,
    module: q.module,
    category: q.category,
    question: q.q,
    answer: texts[i],
    answer_mode: 'text',
    skipped: false,
  }));
}

/* ─────────────────────────────── run ─────────────────────────────── */
const supabase = admin();

async function findUser() {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data?.users || []).find((u) => String(u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if ((data?.users || []).length < 200) break;
  }
  return null;
}

const user = await findUser();
if (!user) {
  console.error(`No auth user found for ${email}`);
  process.exit(1);
}

const { data: creator, error: creatorErr } = await supabase
  .from('legacy_creators')
  .select('id, display_name, avatar_level, completion_score')
  .eq('user_id', user.id)
  .maybeSingle();
if (creatorErr) throw creatorErr;
if (!creator) {
  console.error(`${email} has no archive yet. Sign in once so the creator row exists, then re-run.`);
  process.exit(1);
}

const creatorId = creator.id;
console.log(`Seeding archive ${creatorId} (${creator.display_name || 'no name'}) for ${email}`);

async function clearSeeded(table) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('creator_id', creatorId)
    .eq('metadata->>seed', SEED);
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function insert(table, rows) {
  const tagged = rows.map((r) => ({ ...r, creator_id: creatorId, metadata: { seed: SEED } }));
  const { error } = await supabase.from(table).insert(tagged);
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`  ${table}: ${rows.length}`);
}

for (const table of [
  'legacy_memories', 'legacy_relationships', 'legacy_values',
  'legacy_wisdom', 'legacy_threads', 'legacy_gallery_items',
]) {
  await clearSeeded(table);
}

await insert('legacy_memories', MEMORIES);
await insert('legacy_relationships', RELATIONSHIPS);
await insert('legacy_values', VALUES);
await insert('legacy_wisdom', WISDOM);
await insert('legacy_threads', THREADS.map((t) => ({ ...t, status: 'open' })));

/* Photographs — copy an image already in the bucket so every row resolves to a
   real file and the owner can delete rows without breaking the others. */
const { data: files, error: listErr } = await supabase.storage
  .from(BUCKET)
  .list(creatorId, { limit: 200 });
if (listErr) throw listErr;

const sources = (files || [])
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name) && !f.name.startsWith('seed-'))
  .map((f) => `${creatorId}/${f.name}`);

if (sources.length === 0) {
  console.log('  legacy_gallery_items: skipped (no image in storage to copy)');
} else {
  const rows = [];
  for (let i = 0; i < GALLERY.length; i++) {
    const from = sources[i % sources.length];
    const ext = from.split('.').pop().toLowerCase();
    const to = `${creatorId}/seed-gallery-${i + 1}.${ext}`;
    await supabase.storage.from(BUCKET).remove([to]);
    const { error } = await supabase.storage.from(BUCKET).copy(from, to);
    if (error) throw new Error(`storage copy ${to}: ${error.message}`);
    rows.push({ ...GALLERY[i], image_path: to });
  }
  await insert('legacy_gallery_items', rows);
}

/* Coverage — upsert so hand-made scores for other categories survive. */
const coverageRows = Object.entries(COVERAGE).map(([category, score]) => ({
  creator_id: creatorId, category, score, updated_at: new Date().toISOString(),
}));
const { error: covErr } = await supabase
  .from('legacy_coverage')
  .upsert(coverageRows, { onConflict: 'creator_id,category' });
if (covErr) throw covErr;
console.log(`  legacy_coverage: ${coverageRows.length}`);

/* Personality — merge, and never touch explicit identity. */
const { data: prev } = await supabase
  .from('legacy_personality_profiles')
  .select('profile, favorite_phrases')
  .eq('creator_id', creatorId)
  .maybeSingle();
const prevProfile = prev?.profile && typeof prev.profile === 'object' ? prev.profile : {};
const profile = { ...prevProfile, ...PERSONALITY };
if (prevProfile.gender != null) profile.gender = prevProfile.gender;
if (prevProfile.pronouns != null) profile.pronouns = prevProfile.pronouns;
const { error: persErr } = await supabase
  .from('legacy_personality_profiles')
  .upsert({
    creator_id: creatorId,
    profile,
    favorite_phrases: PERSONALITY.favorite_phrases,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'creator_id' });
if (persErr) throw persErr;
console.log('  legacy_personality_profiles: 1');

/* Give the untitled hand-uploaded photo a real caption so the gallery is complete. */
const { error: untitledErr } = await supabase
  .from('legacy_gallery_items')
  .update({
    title: 'Portrait study',
    caption: 'A still used while setting up the live avatar.',
    updated_at: new Date().toISOString(),
  })
  .eq('creator_id', creatorId)
  .is('title', null);
if (untitledErr) throw untitledErr;

/* Interview — complete all three stages with real answers. */
const STAGE_META = {
  foundation: {
    label: 'Foundation Interview',
    answers: answersFor(FOUNDATION_QUESTIONS, FOUNDATION_ANSWERS),
    duration: 2100,
    summary:
      'Foundation covered: childhood in Haifa, the Friday table, both parents, and the garage summer that shaped how he talks about work. Voice is concrete and understated.',
    next: ['relationships', 'love_family', 'career'],
  },
  enriched: {
    label: 'Enriched Interview',
    answers: answersFor(ENRICHED_QUESTIONS, ENRICHED_ANSWERS),
    duration: 2600,
    summary:
      'Enriched session went deep on Noa, the wedding, the first company closing, and the births. Strongest material is about waiting rather than pushing.',
    next: ['legacy_remembered', 'legacy_letter', 'legacy_hope'],
  },
  legacy: {
    label: 'Legacy Interview',
    answers: answersFor(LEGACY_QUESTIONS, LEGACY_ANSWERS),
    duration: 2400,
    summary:
      'Legacy session named what should be kept: the Friday table, standing at the bottom of the hill, and a letter to people not yet born. Archive setup is complete enough to share.',
    next: [],
  },
};

const { data: sessions, error: sessErr } = await supabase
  .from('legacy_interview_sessions')
  .select('id, stage, status, session_number')
  .eq('creator_id', creatorId)
  .order('session_number');
if (sessErr) throw sessErr;

const byStage = Object.fromEntries((sessions || []).map((s) => [s.stage, s]));
let nextNumber = Math.max(0, ...(sessions || []).map((s) => s.session_number)) + 1;

for (const [stage, meta] of Object.entries(STAGE_META)) {
  let session = byStage[stage];
  if (!session) {
    const { data, error } = await supabase
      .from('legacy_interview_sessions')
      .insert({
        creator_id: creatorId,
        session_number: nextNumber++,
        label: meta.label,
        stage,
        status: 'in_progress',
      })
      .select('id, stage, status, session_number')
      .single();
    if (error) throw error;
    session = data;
    byStage[stage] = session;
  }

  const { error: delAnsErr } = await supabase
    .from('legacy_interview_answers')
    .delete()
    .eq('session_id', session.id);
  if (delAnsErr) throw delAnsErr;

  const rows = meta.answers.map((a) => ({ ...a, session_id: session.id }));
  const { error: ansErr } = await supabase.from('legacy_interview_answers').insert(rows);
  if (ansErr) throw ansErr;

  const { error: updErr } = await supabase
    .from('legacy_interview_sessions')
    .update({
      status: 'processed',
      completed_at: new Date().toISOString(),
      duration_seconds: meta.duration,
      session_summary: { text: meta.summary },
      recommended_next_topics: meta.next,
    })
    .eq('id', session.id);
  if (updErr) throw updErr;
  console.log(`  ${stage}: ${meta.answers.length} answers, processed`);
}

const { error: crErr } = await supabase
  .from('legacy_creators')
  .update({ avatar_level: 3, completion_score: 94, updated_at: new Date().toISOString() })
  .eq('id', creatorId);
if (crErr) throw crErr;
console.log('  legacy_creators: avatar_level 3, completion_score 94');

console.log('\nDone. Reload the archive to see it.');
