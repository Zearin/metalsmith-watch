import {
  relative as relativePath,
  resolve as resolvePath,
  isAbsolute as isAbsolutePath,
  normalize as normalizePath
} from "path"

import gaze from "gaze"
import color from "chalk"
import multimatch from "multimatch"

import {
  ok, nok,
  livereloadFiles,
  runOnUpdateCallback,
  runAndUpdate,
  buildFiles,
  buildPattern
} from "./lib/core"
import livereloadServer from "./lib/livereload"
import {
  backupCollections, 
  updateCollections, 
  saveFilenameInFilesData, 
  removeFilesFromCollection
} from "./lib/collectionsFixes"


const jsFileRE = /\.(jsx?|es\d{0,1})$/


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
