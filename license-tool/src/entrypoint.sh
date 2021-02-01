#!/bin/bash

if [ ! -f yarn.lock ]; then
    echo "Can't find yarn.lock. Generate lock file and try again."
    exit 1
fi

DASH_LICENSES=dash-licenses/core/target/org.eclipse.dash.licenses-0.0.1-SNAPSHOT.jar
if [ ! -f $DASH_LICENSES ]; then
    echo "Can't find org.eclipse.dash.licenses-0.0.1-SNAPSHOT.jar. Rebuild 'nodejs-license-tool' image and try again."
    exit 1
fi

node dash-licenses/yarn/index.js | java -jar $DASH_LICENSES -
echo "The DEPENDENCIES file is being generated..."
node ./bump-deps.js
echo "Done."
