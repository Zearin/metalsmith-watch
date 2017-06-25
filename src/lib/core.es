import async from "async"
import color from "chalk"
import unyield from "unyield"
import multimatch from "multimatch"

import {
  backupCollections, 
  updateCollections, 
  saveFilenameInFilesData, 
  removeFilesFromCollection
} from "./collectionsFixes"


export const ok  = color.green("✔︎")
export const nok = color.red("✗")

// only first file that require something has it in its children
// so relying on children to invalidate sibling is not doable
// function invalidateCache(from, path, options) {
//   // we invalidate cache only for files in metalsmith root
//   if (require.cache[path] && path.indexOf(from) === 0) {
//     Object.keys(require.cache)
//       .filter(file => file.indexOf(from) === 0)
//       .filter(file => require.cache[file].children.indexOf(require.cache[path]) > -1)
//       .forEach(file => {
//         console.log(file, "is in children")
//         invalidateCache(from, file, options)
//       })
//
//     delete require.cache[path]
//     options.log(`${relativePath(from, path)} cache deleted`)
//     return true
//   }
//   return false
// }

export function livereloadFiles(livereload, files, options) {
  if (livereload) {
    const keys = Object.keys(files)
    const nbOfFiles = Object.keys(files).length
    options.log(`${ok} ${nbOfFiles} file${nbOfFiles > 1 ? "s" : ""} reloaded`)
    livereload.changed({body: {files: keys}})
  }
}

export function runOnUpdateCallback(onUpdateCallback, files, options) {
  if (onUpdateCallback) {
    onUpdateCallback(files, options)
  }
}

export function runAndUpdate(metalsmith, files, livereload, onUpdateCallback, options, previousFilesMap) {
  /*
   *  metalsmith-collections fix: 
   *  
   *  the `metalsmith-collections` plugin adds files to collection when `run()` is 
   *  called, which creates problem since we use `run()` with only new files.
   *  
   *  In order to prevent duplicate issue (i.e. some contents will be available in 
   *  collections with both new and the previous versions), we:
   *  
   *  1.  remove from existing collections files that will be updated 
   *      (files already in the collections)
   *  2.  iterate over collections with references to previous files data
   *  3.  skip old files whose paths match those that will be updated
   *  
   *  (sigh)
   */
  saveFilenameInFilesData(metalsmith, files, options)
  const collections = metalsmith.metadata().collections
  const collectionsBackup = backupCollections(collections)
  if (collections) {
    // mutability ftl :(
    removeFilesFromCollection(files, collections)

    // metalsmith-collections fix: prepare collections with partials items
    // run() below will add the new files to the collections
    updateCollections(metalsmith, collections)
  }

  metalsmith.run(files, function(err, freshFiles) {
    if (err) {
      if (collections) {
        // metalsmith-collections fix: rollback collections
        updateCollections(metalsmith, collectionsBackup)
      }

      options.log(color.red(`${nok} ${err.toString()}`))
      // babel use that to share information :)
      if (err.codeFrame) {
        err.codeFrame.split("\n").forEach(line => options.log(line))
      }
      return
    }

    // metalsmith-collections fix:  update ref for future tests
    Object.keys(freshFiles).forEach(path => {
      previousFilesMap[path] = freshFiles[path]
    })

    metalsmith.write(freshFiles, function(writeErr) {
      if (writeErr) {throw writeErr}

      livereloadFiles(livereload, freshFiles, options)
      runOnUpdateCallback(onUpdateCallback, freshFiles, options)
    })
  })
}

export function buildFiles(metalsmith, paths, livereload, onUpdateCallback, options, previousFilesMap) {
  const files = {}
  const metadata = metalsmith.metadata()
  async.each(
    paths,
    
    (path, cb) => {
      metalsmith.readFile(path, function(err, file) {
        if (err) {
          options.log(color.red(`${nok} ${err}`))
          return
        }

        if (metadata && metadata.permalinkMapping) {
          const originalFilename = metadata.permalinkMapping[path]
          if (originalFilename && previousFilesMap[originalFilename]) {
            file = Object.assign({}, previousFilesMap[originalFilename], file)
            file[originalFilename] = file
          } else {
            files[path] = file
          }
        } else {
          files[path] = file
        }

        cb()
      })
    },
    
    (err) => {
      if (err) {
        options.log(color.red(`${nok} ${err}`))
        return
      }

      const nbOfFiles = Object.keys(files).length
      options.log(color.gray(`- Updating ${nbOfFiles} file${nbOfFiles > 1 ? "s" : ""}...`))
      runAndUpdate(metalsmith, files, livereload, onUpdateCallback, options, previousFilesMap)
    }
  )
}

export function buildPattern(metalsmith, patterns, livereload, onUpdateCallback, options, previousFilesMap) {
  unyield(metalsmith.read())(
    (err, files) => {
      if (err) {
        options.log(color.red(`${nok} ${err}`))
        return
      }

      const filesToUpdate = {}
      multimatch(Object.keys(files), patterns).forEach(path => filesToUpdate[path] = files[path])
      const nbOfFiles = Object.keys(filesToUpdate).length
      options.log(color.gray(`- Updating ${nbOfFiles} file${nbOfFiles > 1 ? "s" : ""}...`))
      runAndUpdate(metalsmith, filesToUpdate, livereload, onUpdateCallback, options, previousFilesMap)
    }
  )
}
