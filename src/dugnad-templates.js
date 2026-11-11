// Central equipment checklists for common community work. They are only suggestions: applying one
// copies its items into the event, so editing a template here never changes an existing event.
// Each item: [English name, Norwegian name, suggested quantity, essential by default].
module.exports = [
  {
    category: 'cleanup', name: 'Neighbourhood cleanup', name_nb: 'Rydding i nabolaget',
    description: 'Litter, leaves and general tidying outdoors.', description_nb: 'Søppel, løv og generell rydding utendørs.',
    items: [
      ['Trash bags', 'Søppelsekker', 10, 1], ['Litter pickers', 'Plukketenger', 4, 0], ['Work gloves', 'Arbeidshansker', 6, 1],
      ['Brooms', 'Koster', 3, 0], ['Rakes', 'Raker', 3, 0], ['Safety vests', 'Refleksvester', 6, 0],
    ],
  },
  {
    category: 'gardening', name: 'Community gardening', name_nb: 'Felles hagearbeid',
    description: 'Planting, weeding and pruning in shared gardens.', description_nb: 'Planting, lukking og beskjæring i fellesarealer.',
    items: [
      ['Spades', 'Spader', 2, 1], ['Shovels', 'Skuffer', 2, 0], ['Rakes', 'Raker', 3, 0], ['Wheelbarrows', 'Trillebårer', 1, 1],
      ['Watering cans', 'Vannkanner', 2, 0], ['Gardening gloves', 'Hagehansker', 4, 0], ['Pruning tools', 'Beskjæringssakser', 2, 0],
    ],
  },
  {
    category: 'painting', name: 'Painting and maintenance', name_nb: 'Maling og vedlikehold',
    description: 'Painting and fixing communal rooms, fences and furniture.', description_nb: 'Maling og reparasjon av fellesrom, gjerder og møbler.',
    items: [
      ['Paint rollers', 'Malerruller', 3, 1], ['Paintbrushes', 'Malekoster', 4, 1], ['Paint trays', 'Malerbrett', 2, 0],
      ['Drop cloths', 'Tildekkingsduk', 2, 1], ['Sandpaper', 'Sandpapir', 1, 0], ['Ladders', 'Stiger', 1, 0], ['Protective equipment', 'Verneutstyr', 1, 0],
    ],
  },
  {
    category: 'snow', name: 'Snow clearing', name_nb: 'Måking av snø',
    description: 'Clearing snow and ice from shared paths and entrances.', description_nb: 'Måking av snø og is på fellesveier og innganger.',
    items: [
      ['Snow shovels', 'Snøskuffer', 4, 1], ['Ice scrapers', 'Isskrapere', 2, 0], ['Brooms', 'Koster', 2, 0],
      ['Suitable protective equipment', 'Egnet verneutstyr', 1, 0],
    ],
  },
  {
    category: 'gathering', name: 'Community gathering', name_nb: 'Felles samling',
    description: 'Setting up and clearing away after a neighbourhood get-together.', description_nb: 'Oppsett og opprydding etter en nabosamling.',
    items: [
      ['Folding tables', 'Klappbord', 3, 1], ['Chairs', 'Stoler', 10, 1], ['Extension cords', 'Skjøteledninger', 2, 0],
      ['Cleaning supplies', 'Rengjøringsutstyr', 1, 0], ['Serving equipment', 'Serveringsutstyr', 1, 0],
    ],
  },
];
