stm.js
======

### Serve videos to StreamToMe clients

Why Use This?
-------------

There are two other options for serving to StreamToMe clients. The first is
the [official ServeToMe](http://zqueue.com/servetome/index.html), but that
only runs on Mac OS X and Windows. If you want to run on Linux, you're out
of luck.

The second option is [servetome](https://code.google.com/p/servetome/). This
is what I used for a number of years but it has a few flaws. First, it
contains races and locks up quite often. Second, it requires a custom hacked
up version of ffmpeg—it is severely out of date at this point and is a huge
hassle to patch and build. Lastly, the project hasn't had any code updates
since 2010, which leads me to believe it is abandoned.

Stm.js  was specifically designed to avoid races and runs on Linux with
a stock ffmpeg (av_conv is untested). It runs on Node.js.

Running
-------

1. Install node.js dependencies:

        npm install

2. Create a config file in `~/.stm-config.yaml`. The only required config
   option is the array of paths to serve:

        serve_paths:
          - path: /some/paths/to/my/movies
            name: Movies

3. Start the server:

        node stm.js

Copyright And License
---------------------

Copyright © 2013-2014 by David Caldwell

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
