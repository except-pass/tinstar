# Easy `git` flow

So a very typical flow should look like this:

0. Update your local master branch however you desire (`git pull` or `git fetch && git rebase`)

1. Create new branch (`git checkout -b <branch-name>`)

2. Great, now you're in your branch doing some work. There are likely going to be other changes happening in other branches, most notably master. For non-master branches - life gets easier if you just ignore the changes.

    For dealing with changes in master, here are two rules of thumb:

    - *Rebase.* If no one else besides you is looking at your code (i.e you haven't made a PR and asked for eyeballs) then I like to rebase. Keeps things cleaner, and usually conflicts are the same amount of pain as a merge but there's no need to care about changing history
      * Checkout your branch
      * `git rebase master`

    - *Merge.* If you have pushed a branch and someone else is looking at your code (especially if they've left comments on github), then it's better to merge. Stuff gets messier when you start blowing away history at this point
      * Checkout your branch
      * `git merge master`




### A typical (but stylized) git history

`git checkout master`

`git fetch && git rebase`

`git checkout -b feature-branch`

`git commit -m "I fixed that feature your mom was asking me about last night"`

`git commit -m "I fixed that OTHER feature your mom was asking me about, heh"`

oops new change landed in master

`git checkout master` 

`git fetch && git rebase`

`git checkout feature-branch`

`git rebase master` <--- no one cares besides you, rebase away!

`git commit -m "Your sister was bugging me so I add this feature also"`

`git push` 

people start leaving comments are this fine piece of hackery you're working on

oh but look, more changes on master! 

`git checkout master`

`git fetch && git rebase`

`git checkout feature-branch`

`git merge master` <--- don't rebase here, it will make your reviewers sad

`git commit -m "Now this one is for your grandma"`

`git push`

BOOM, your changes have landed on master

`git checkout master`

`git fetch && git rebase`
