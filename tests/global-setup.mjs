import { makeFixtures, fixtureExists } from './make-fixtures.mjs';

export default async function globalSetup() {
  if (!fixtureExists('fixture.png')) await makeFixtures();
}
