import * as fs from 'fs'

const dynamicRequire = (name) => {
  return name
}

export function loadPlugin(name) {
  return dynamicRequire(name)
}
