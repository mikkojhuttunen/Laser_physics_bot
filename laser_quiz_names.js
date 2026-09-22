'use strict';

// Hidden XP ladder (weekly XP -> "level" persona). Sorted high to low; last entry must have min: 0.
// Never sent to students in full: the bot only reveals the current level and shows "???" for the next one.
// Bands are 50 XP wide from 0 to 350 (quick early wins), then 100 XP wide up to 1000.
// Gender split: 7 women, 8 men.
const LEVELS = [
  { min: 1000, name: 'Theodore Maiman',       g: 'M', blurb: 'built the first working laser (1960)' },
  { min: 900,  name: 'Arthur Schawlow',       g: 'M', blurb: 'proposed the laser with Townes (1958) and pioneered laser spectroscopy (Nobel Prize 1981)' },
  { min: 800,  name: 'Albert Einstein',       g: 'M', blurb: 'predicted stimulated emission (1917)' },
  { min: 700,  name: 'Donna Strickland',      g: 'F', blurb: 'co-invented chirped-pulse amplification (Nobel Prize 2018)' },
  { min: 600,  name: 'Charles Townes',        g: 'M', blurb: 'built the first maser (1953) and shared the 1964 Nobel Prize' },
  { min: 500,  name: "Anne L'Huillier",       g: 'F', blurb: 'pioneered attosecond pulses from high harmonics (Nobel Prize 2023)' },
  { min: 400,  name: 'Gérard Mourou',         g: 'M', blurb: 'co-invented chirped-pulse amplification (Nobel Prize 2018)' },
  { min: 350,  name: 'Ursula Keller',         g: 'F', blurb: 'invented the SESAM for passive mode locking (1992)' },
  { min: 300,  name: 'Arthur Ashkin',         g: 'M', blurb: 'invented optical tweezers (Nobel Prize 2018)' },
  { min: 250,  name: 'Theodor Hänsch',        g: 'M', blurb: 'developed the optical frequency comb (Nobel Prize 2005)' },
  { min: 200,  name: 'Margaret Murnane',      g: 'F', blurb: 'pioneered ultrafast lasers and coherent soft X-ray generation' },
  { min: 150,  name: 'Elsa Garmire',          g: 'F', blurb: 'a pioneer of nonlinear optics and early semiconductor lasers' },
  { min: 100,  name: 'Michal Lipson',         g: 'F', blurb: 'a pioneer of silicon photonics, integrating lasers and optics onto microchips' },
  { min: 50,   name: 'Maria Goeppert Mayer',  g: 'F', blurb: 'predicted two-photon absorption (1931)' },
  { min: 0,    name: 'Max Planck',            g: 'M', blurb: 'introduced the energy quantum (1900)' },
];

// Anonymous leaderboard aliases. Exactly 20 women and 20 men, disjoint from LEVELS.
// The bot assigns aliases so that the class stays balanced (see pickAlias in laserQuiz.js).
const ALIASES = {
  F: [
    'Ada Lovelace', 'Marie Curie', 'Lise Meitner', 'Emmy Noether', 'Rosalind Franklin',
    'Katherine Johnson', 'Hypatia', 'Sofia Kovalevskaya', 'Chien-Shiung Wu', 'Dorothy Hodgkin',
    'Barbara McClintock', 'Cecilia Payne', 'Grace Hopper', 'Mary Somerville', 'Émilie du Châtelet',
    'Vera Rubin', 'Henrietta Leavitt', 'Maryam Mirzakhani', 'Caroline Herschel', 'Sophie Germain',
  ],
  M: [
    'Isaac Newton', 'Carl Gauss', 'Leonhard Euler', 'Richard Feynman', 'Paul Dirac',
    'Niels Bohr', 'Srinivasa Ramanujan', 'Alan Turing', 'Galileo Galilei', 'James Clerk Maxwell',
    'Michael Faraday', 'Erwin Schrödinger', 'Werner Heisenberg', 'Johannes Kepler', 'Bernhard Riemann',
    'Enrico Fermi', 'C. V. Raman', 'Satyendra Nath Bose', 'Blaise Pascal', 'Pierre de Fermat',
  ],
};

module.exports = { LEVELS, ALIASES };
