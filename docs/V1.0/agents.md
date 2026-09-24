# AI Office

The goal of this project is ...

creat a AGENTIC AI TEAM That is able to manage the implementation of a solution from Jira TASKS. this shoulde configurable to work on any diferent type of project with the same architecture ACTS Company. 

## US Creation module

The app should implement a US creation module based on a chat in the UI

## Agentes

All agents should have a configurable triget and IO as well as a set of mcps

## BA

- Create the story in jira following the best practices from the requirement from the chat.
- Should Document all bussines decitions

### PM

- Calculate the prioryti of a US
- Calculate Schedule dates. strat date  
- Calculate Story points based on the difficulty of the US

### DEV
Once the DEV agent start a task...

-  agent should execute command /acts-workflow-managed. auto accept all.
- Dev should comment if the US should be tested by qa or just is a code change. if the US is testable dev should add a sub-task in the US for the qa on how to test.

### QA
Once the QA agent start a task...

- Use automated testing to test the stories. 
- Each sub-task should have its test suit 
- the US preferd ways Playwrite or API e2e test suit.

### DEVOPS
