show a directory listing of a given project


project

show a tree structure.  

entry and children.  The entry is a list of what to show.  It is just an array of stuff to show.

For example
```
> [icons]  [file_name] [stats implemented as icons]
```

always show the expander for directories

icons: list of icon objects with icon_image, text, background color and tooltip.
support filetype as a special icon type.
support open editor as a special icon type that opens the editor of the file you click on.

file name: str of the filename


canned views.  

project view:

icons
- is the file/dir included in git or in uniginored files.
    -- filled circle.  file is included
    -- open circle.  a directory has a mixture of files under it
    -- X.  a file or directory is not included.
- filetype icon
- filename
- open editor

agent summary view

- filetype icon
- filename
- green + with number of lines 
- red - with number of lines
- open editor

- lines added and removed is aggregated