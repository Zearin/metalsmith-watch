import metalsmithFilenames from "metalsmith-filenames"

const addFilenames = metalsmithFilenames()

// metalsmith-collections fix: collections are mutable
// fuck mutability
export function backupCollections(collections) {
  const collectionsBackup = {}
  if (typeof collections === "object") {
    Object.keys(collections).forEach(key => {
      collectionsBackup[key] = [...collections[key]]
    })
  }
  return collectionsBackup
}

// metalsmith-collections fix: collections are in metadata as is + under metadata.collections
export function updateCollections(metalsmith, collections) {
  const metadata = {
    ...metalsmith.metadata(),
    collections,
  }
  // copy ref to metadata root since metalsmith-collections use this references
  // as primary location (*facepalm*)
  Object.keys(collections).forEach(key => {
    metadata[key] = collections[key]
  })
  metalsmith.metadata(metadata)
}

// metalsmith-collections fix: helps to update fix collections
export function saveFilenameInFilesData(metalsmith, files, options) {
  addFilenames(files)
  /*
  const relativeRoot = options.relativeRoot ? options.relativeRoot : metalsmith.source();
  Object.keys(files).forEach(filename => {
    if (!files[filename].filename) {
      console.log('svaing.... ', normalizePath(relativePath(relativeRoot, filename)))
      files[filename].filename = normalizePath(relativePath(relativeRoot, filename))
    }
  })
  */
}

// metalsmith-collections fix: remove items from collections that will be readded by the partial build
export function removeFilesFromCollection(files, collections) {
  const filenames = Object.keys(files)
  Object.keys(collections).forEach(key => {

    for (let i = 0; i < collections[key].length; i++) {
      if (filenames.indexOf(collections[key][i].filename) > -1) {
        collections[key] = [
          ...collections[key].slice(0, i),
          ...collections[key].slice(i + 1),
        ]
        i--
      }
    }
  })
}
