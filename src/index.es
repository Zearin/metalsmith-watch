import {
  relative as relativePath,
  resolve as resolvePath,
  isAbsolute as isAbsolutePath,
  normalize as normalizePath
} from "path"

import async from "async"
import gaze from "gaze"
import color from "chalk"
import multimatch from "multimatch"
import unyield from "unyield"

import livereloadServer from "./livereload"
import {
  backupCollections, 
  updateCollections, 
  saveFilenameInFilesData, 
  removeFilesFromCollection
} from "./collectionsFixes"


const jsFileRE = /\.(jsx?|es\d{0,1})$/

const ok  = color.green("✔︎")
const nok = color.red("✗")

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

function livereloadFiles(livereload, files, options) {
  if (livereload) {
    const keys = Object.keys(files)
    const nbOfFiles = Object.keys(files).length
    options.log(`${ok} ${nbOfFiles} file${nbOfFiles > 1 ? "s" : ""} reloaded`)
    livereload.changed({body: {files: keys}})
  }
}

function runOnUpdateCallback(onUpdateCallback, files, options) {
  if (onUpdateCallback) {
    onUpdateCallback(files, options)
  }
}

function runAndUpdate(metalsmith, files, livereload, onUpdateCallback, options, previousFilesMap) {
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

function buildFiles(metalsmith, paths, livereload, onUpdateCallback, options, previousFilesMap) {
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

function buildPattern(metalsmith, patterns, livereload, onUpdateCallback, options, previousFilesMap) {
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

export default function(options) {
  options = {
    ...{
      paths: "${source}/**/*",
      livereload: false,
      log: (...args) => {
        console.log(color.gray("[metalsmith-watch]"), ...args)
      },
      invalidateCache: true,
    },
    ...(options || {}),
  }

  if (typeof options.paths === "string") {
    options.paths = {[options.paths]: true}
  }

  let livereload
  if (options.livereload) {
    livereload = livereloadServer(options.livereload, options.log)
  }

  let onUpdateCallback
  if (options.onUpdateCallback && typeof options.onUpdateCallback === 'function') {
    onUpdateCallback = options.onUpdateCallback.bind(this)
  }

  let watched = false
  const plugin = function metalsmithWatch(files, metalsmith, cb) {

    // only run this plugin once
    if (watched) {
      cb()
      return
    }
    watched = true

    // metalsmith-collections fix: keep filename as metadata
    saveFilenameInFilesData(metalsmith, files, options)

    const patterns = {}
    Object.keys(options.paths).map(pattern => {
      let watchPattern = pattern.replace("${source}", metalsmith.source())
      if (!isAbsolutePath(watchPattern)) {
        watchPattern = resolvePath(metalsmith.directory(), pattern)
      }
      const watchPatternRelative = relativePath(metalsmith.directory(), watchPattern)
      patterns[watchPatternRelative] = options.paths[pattern]
    })
    
    const gazePatterns = Object.keys(patterns)
    const gazeOptions  = {
        ...options.gaze,
        cwd: metalsmith._directory,
      }
    const gazeCallback = function watcherReady(err, watcher) {
      if (err) {throw err}

      Object.keys(patterns).forEach(pattern => {
        options.log(`${ok} Watching ${color.cyan(pattern)}`)
      })

      const previousFilesMap = {...files}

      //  Delay watch update in order to bundle multiple updates 
      //  in the same build
      //  (Otherwise, saving multiples files at the same time triggers 
      //  multiple builds)
      let updateDelay   = 50
      let updatePlanned = false
      let pathsToUpdate = []
      
      // since I can't find a way to do a smart cache cleaning
      // (see commented invalidateCache() method)
      // here is a more brutal way (that works)
      const update = () => {
        if (
          options.invalidateCache &&
          // only if there is a js file
          pathsToUpdate.some(file => file.match(jsFileRE))
        ) {
          const filesToInvalidate = Object.keys(patterns)
            .reduce((acc, pattern) => {
              return [
                ...acc,
                ...multimatch(
                  Object.keys(require.cache),
                  `${resolvePath(metalsmith._directory)}/${pattern}`
                ),
              ]
            }, [])
          if (filesToInvalidate.length) {
            options.log(color.gray(`- Deleting cache for ${filesToInvalidate.length} entries...`))
            filesToInvalidate.forEach(file => delete require.cache[file])
            options.log(`${ok} Cache deleted`)
          }
        }

        const patternsToUpdate = Object.keys(patterns).filter(pattern => patterns[pattern] === true)
        const filesToUpdate = multimatch(pathsToUpdate, patternsToUpdate).map((file) => {
          const filepath = resolvePath(metalsmith.path(), file)
          return relativePath(metalsmith.source(), filepath)
        })
        if (filesToUpdate.length) {
          buildFiles(metalsmith, filesToUpdate, livereload, onUpdateCallback, options, previousFilesMap)
        }

        const patternsToUpdatePattern = Object.keys(patterns)
          .filter(pattern => patterns[pattern] !== true)
          .filter(pattern => multimatch(pathsToUpdate, pattern).length > 0)
          .map(pattern => patterns[pattern])

        if (patternsToUpdatePattern.length) {
          buildPattern(metalsmith, patternsToUpdatePattern, livereload, onUpdateCallback, options, previousFilesMap)
        }
        // console.log(pathsToUpdate, filesToUpdate, patternsToUpdatePattern)

        // cleanup
        pathsToUpdate = []
      }

      watcher.on("all", (event, path) => {
        const filename = relativePath(metalsmith._directory, path)

        if (
          event === "added"   ||
          event === "changed" ||
          event === "renamed" ||
          event === "deleted"
        ) {
          options.log(`${ok} ${color.cyan(filename)} ${event}`)
        }

        // if (event === "changed") {
        //   if (options.invalidateCache) {
        //     invalidateCache(
        //       resolvePath(metalsmith._directory),
        //       resolvePath(path),
        //       options
        //     )
        //   }
        // }

        if (
          event === "added"   ||
          event === "changed" ||
          event === "renamed"
        ) {
          pathsToUpdate.push(relativePath(metalsmith.path(), path))
          if (updatePlanned) {
            clearTimeout(updatePlanned)
          }
          updatePlanned = setTimeout(update, updateDelay)
        }
      })

      plugin.close = () => {
        if (typeof watcher === "object") {
          watcher.close()
          watcher = undefined
        }
      }
    }
    
    gaze(gazePatterns, gazeOptions, gazeCallback)
    
    cb()
  }

  // convenience for testing
  plugin.options = options

  return plugin
}
